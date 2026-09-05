/**
 * The live services wiring: the base ports pass through by reference and the
 * auth + tx seams swap for the wallet-backed implementations. Market data,
 * trading, earning, and minting stay exactly what they were — protocol
 * surfaces never learn which adapter serves them, and product writes will
 * reach the chain through TxPort.run when the protocol lands.
 */

import type { Services, TxPort } from "@/domain/ports";
import type { TxRecord, TxSpec } from "@/domain/types";
import { getActiveChain, chainLabel } from "@/data/web3/chains";
import { TxStore } from "@/data/web3/tx-store";
import { PrivyAuthPort } from "./privy-auth-port";

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

  constructor(private base: Services) {
    this.auth = new PrivyAuthPort();
    this.tx = new WalletTxPort(this.auth);
  }

  get marketData() {
    return this.base.marketData;
  }

  get trading() {
    return this.base.trading;
  }

  get earn() {
    return this.base.earn;
  }

  get mint() {
    return this.base.mint;
  }
}
