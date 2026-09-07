/**
 * The live services wiring: the base ports pass through by reference and the
 * auth + tx seams swap for the wallet-backed implementations. Market data
 * stays exactly what it was. Actions reach the chain through the shared
 * ActionRunner over the wallet-backed tx port; the per-surface ports
 * (trading/earn/mint) adopt it as their implementations go live.
 */

import type { ActionPort, Services, TxPort } from "@/domain/ports";
import type { TxRecord, TxSpec } from "@/domain/types";
import { getActiveChain, chainLabel } from "@/data/web3/chains";
import { TxStore } from "@/data/web3/tx-store";
import { ActionRunner } from "@/data/web3/action-runner";
import { getPublicClient } from "@/data/web3/public-client";
import { getOnchainAccountStore, OnChainAccountStore } from "@/data/onchain/account-store";
import {
  getIndexedActivityStore,
  IndexedActivityStore,
} from "@/data/protocol/activity-store";
import { getProtocolMarketStore, ProtocolMarketStore } from "@/data/protocol/market-store";
import { makeReconciler } from "@/data/onchain/reconcile";
import { getIndexerClient } from "@/data/indexer/indexer-client";
import { OnChainMintPort } from "@/data/web3/gusd/onchain-mint-port";
import { OnChainEarnPort } from "@/data/web3/earn/onchain-earn-port";
import { OnChainTradingPort } from "@/data/web3/trading/onchain-trading-port";
import { AcrossBridgePort } from "@/data/web3/bridge/across";
import { PrivyAuthPort } from "./privy-auth-port";
import { disposeAvailabilityCache, disposeProbeCache } from "@/data/web3/trading/quotes";

/**
 * The transaction port over the lifecycle engine: pre-flight session and
 * network checks (product-voiced refusals — no signature is ever requested
 * from a session that can't sign), then the store drives the rest.
 */
class WalletTxPort implements TxPort {
  private store = new TxStore();

  constructor(private auth: PrivyAuthPort) {}

  list(): readonly TxRecord[] {
    return this.store.list();
  }

  get(id: string): TxRecord | null {
    return this.store.get(id);
  }

  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener);
  }

  clear(): void {
    this.store.clear();
  }

  async run(spec: TxSpec): Promise<TxRecord> {
    const session = this.auth.getSession();
    if (session.status !== "connected" || !session.address) {
      throw new Error("Connect a wallet first — nothing signs without one.");
    }
    const active = getActiveChain();
    if (session.networkOk === false) {
      throw new Error(
        `Wrong network — this desk trades on ${chainLabel(active.id) ?? active.name}. Switch the wallet's network and try again.`,
      );
    }
    const wallet = await this.auth.getWalletClient(active.id);
    return this.store.run(spec, wallet);
  }
}

export class Web3Services implements Services {
  readonly auth: PrivyAuthPort;
  readonly tx: WalletTxPort;
  readonly actions: ActionPort;
  /** The interim onchain user-state store (the Ponder successor lands later). */
  readonly accountStore: OnChainAccountStore;
  /** The indexed wallet-activity store (rows for the ledgers). */
  readonly activityStore: IndexedActivityStore;
  /** The indexed protocol market store, when one stands behind this deployment. */
  readonly protocolStore: ProtocolMarketStore | null;

  constructor(private base: Services) {
    this.auth = new PrivyAuthPort();
    this.tx = new WalletTxPort(this.auth);
    this.actions = new ActionRunner({
      tx: this.tx,
      // The block-based half of the stale-quote guard; the wall-clock half
      // needs no client. Null on a client without access — the age check
      // still applies.
      getBlockNumber: async () => {
        try {
          return Number(await getPublicClient().getBlockNumber());
        } catch {
          return null;
        }
      },
    });
    this.accountStore = getOnchainAccountStore();
    this.activityStore = getIndexedActivityStore();
    this.protocolStore = getProtocolMarketStore();
    // Session binding: the stores follow the one wallet; ending the session
    // clears the wallet state and the session's tx + action records.
    this.auth.subscribeSession((session) => {
      const address = session.status === "connected" ? session.address : null;
      this.accountStore.setAddress(address);
      this.activityStore.setAddress(address);
      if (session.status === "idle") {
        this.tx.clear();
        this.actions.clear();
      }
    });
    // Post-confirmation reconciliation: the store re-read (always), the
    // indexed stores re-pull (activity rows + market state), the settled
    // seam drops quote caches, and the indexed-evidence fetch once Ponder
    // stands behind NEXT_PUBLIC_INDEXER_URL.
    const reconcile = makeReconciler({
      accountStore: this.accountStore,
      earn: { refresh: () => this.earn.refresh() },
      indexer: getIndexerClient(),
      tx: this.tx,
      activity: this.activityStore,
      protocol: this.protocolStore ?? undefined,
      onSettled: () => {
        disposeAvailabilityCache();
        disposeProbeCache();
      },
    });
    this.mint = new OnChainMintPort({
      getSession: () => this.auth.getSession(),
      actions: this.actions,
      reconcile,
    });
    this.earn = new OnChainEarnPort({
      getSession: () => this.auth.getSession(),
      actions: this.actions,
      reconcile,
    });
    this.bridge = new AcrossBridgePort({
      getSession: () => this.auth.getSession(),
      getWalletClient: (chainId) => this.auth.getWalletClient(chainId),
      switchChain: (chainId) => this.auth.switchChain(chainId),
    });
    this.trading = new OnChainTradingPort({
      getSession: () => this.auth.getSession(),
      actions: this.actions,
      accountStore: this.accountStore,
      reconcile,
    });
  }

  readonly mint: OnChainMintPort;
  readonly earn: OnChainEarnPort;
  readonly bridge: AcrossBridgePort;
  readonly trading: OnChainTradingPort;

  get marketData() {
    return this.base.marketData;
  }
}
