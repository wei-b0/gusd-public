/**
 * Oracle-mode wiring: the composite market-data port over the oracle feed,
 * and the REAL execution seams — the on-chain ports over the shared action
 * runner, wired to the walletless auth. Without a Privy app id nothing can
 * sign, so the ports serve their public surface walletless (the vault's
 * share price and seed gate, the router's quotes, the chain-shaped account
 * view) and refuse to act in the product's own voice — exactly the deployed
 * app's guest state. With Privy configured, Web3Services swaps auth, tx,
 * and the execution ports for the wallet-backed implementations built over
 * this same base. Nothing mock remains in the oracle path; the mock
 * universe exists only behind NEXT_PUBLIC_DATA_SOURCE=mock.
 */

import type { ActionPort, Services } from "@/domain/ports";
import { MockServices } from "../mock/mock-services";
import { getOracleFeed } from "./feed";
import { OracleMarketData } from "./oracle-market-data";
import { protocolMarketEnabled } from "@/data/protocol/enabled";
import { getProtocolMarketStore } from "@/data/protocol/market-store";
import { getIndexedActivityStore } from "@/data/protocol/activity-store";
import {
  getOnchainAccountStore,
  OnChainAccountStore,
} from "@/data/onchain/account-store";
import { makeReconciler } from "@/data/onchain/reconcile";
import { getIndexerClient } from "@/data/indexer/indexer-client";
import { getPublicClient } from "@/data/web3/public-client";
import { ActionRunner } from "@/data/web3/action-runner";
import { OnChainMintPort } from "@/data/web3/gusd/onchain-mint-port";
import { OnChainEarnPort } from "@/data/web3/earn/onchain-earn-port";
import { OnChainTradingPort } from "@/data/web3/trading/onchain-trading-port";
import { OnChainPerpPort } from "@/data/web3/perps/onchain-perp-port";
import { InertBridgePort } from "@/data/web3/bridge/inert";
import { disposeAvailabilityCache } from "@/data/web3/trading/quotes";
import { WalletlessAuthPort, WalletlessTxPort } from "@/data/web3/walletless";

export class OracleServices implements Services {
  readonly marketData: OracleMarketData;
  readonly trading: OnChainTradingPort;
  readonly auth: WalletlessAuthPort;
  readonly earn: OnChainEarnPort;
  readonly mint: OnChainMintPort;
  readonly bridge: InertBridgePort;
  readonly perp: OnChainPerpPort;
  readonly tx: WalletlessTxPort;
  readonly actions: ActionPort;
  /** The onchain user-state store the trading port projects. */
  readonly accountStore: OnChainAccountStore;

  constructor() {
    // The mock market-data universe survives as the SCAFFOLDING under the
    // oracle overlay: asset identities and shapes the oracle doesn't
    // publish. Every oracle-backed figure is overlaid from the live feed
    // and nulled when absent (overlayMarket) — no mock value survives.
    const feed = getOracleFeed();
    // The indexed protocol store rides the market seam only when the
    // indexer is configured; mock market mode never gets one.
    const protocol = protocolMarketEnabled() ? getProtocolMarketStore() : null;
    this.marketData = new OracleMarketData(new MockServices().marketData, feed, protocol);

    this.auth = new WalletlessAuthPort();
    this.tx = new WalletlessTxPort();
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

    const accountStore = getOnchainAccountStore();
    this.accountStore = accountStore;
    const reconcile = makeReconciler({
      accountStore,
      earn: { refresh: () => this.earn.refresh() },
      indexer: getIndexerClient(),
      tx: this.tx,
      activity: getIndexedActivityStore(),
      protocol: protocol ?? undefined,
      onSettled: () => {
        disposeAvailabilityCache();
      },
    });

    const session = () => this.auth.getSession();
    this.earn = new OnChainEarnPort({ getSession: session, actions: this.actions, reconcile });
    this.mint = new OnChainMintPort({ getSession: session, actions: this.actions, reconcile });
    this.trading = new OnChainTradingPort({
      getSession: session,
      actions: this.actions,
      accountStore,
      reconcile,
    });
    this.bridge = new InertBridgePort();
    // The perp layer runs on the same walletless base: quotes and market
    // state are public; acting refuses without a session.
    this.perp = new OnChainPerpPort({ getSession: session, actions: this.actions, reconcile });
  }
}
