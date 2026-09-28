/**
 * The walletless seams — the honest null-objects for a build whose wallet
 * auth is not configured (no Privy app id). They are not mocks: nothing is
 * simulated or invented. The session is the real frozen disconnected
 * constant, the ledger is the real empty ledger, and every signing path
 * refuses in one voice. The wallet-backed builds (Web3Services) replace
 * these seams wholesale; the execution ports built on them still serve
 * their public surface (vault facts, quotes) walletless, so a
 * Privy-less oracle build shows the chain's real state and refuses to act
 * exactly like a deployed guest before connecting.
 */

import type { WalletClient } from "viem";
import type { AuthPort, TxPort } from "@/domain/ports";
import type {
  ConnectAction,
  ConnectFlow,
  ConnectableWallet,
  TxRecord,
  TxSpec,
  WalletSession,
} from "@/domain/types";
import { CLOSED_FLOW, SessionStore } from "@/data/auth/session-store";

/** The one honest voice a build without wallet support can speak. */
export const WALLETLESS_VOICE =
  "This build runs without wallet support — nothing can sign here.";

/** The frozen empty ledger — one reference for every reader. */
const NO_TXS: readonly TxRecord[] = Object.freeze([]);

/** The session's transactions before any signing is possible: none. */
export class WalletlessTxPort implements TxPort {
  list(): readonly TxRecord[] {
    return NO_TXS;
  }

  get(): TxRecord | null {
    return null;
  }

  subscribe(): () => void {
    return () => {};
  }

  run(): Promise<TxRecord> {
    return Promise.reject(new Error(WALLETLESS_VOICE));
  }

  clear(): void {}
}

/**
 * Auth for a build without auth: the session store runs for real (frozen
 * snapshots, listener discipline), it just never leaves `idle`. The connect
 * flow opens so the dialog can say why — the dialog renders the flow's
 * error voice above its steps — and every in-flow instruction is a no-op.
 */
export class WalletlessAuthPort implements AuthPort {
  private readonly store = new SessionStore();

  connect(): Promise<void> {
    this.store.setFlow({
      step: "method",
      error: "Wallet login isn't configured in this build.",
    });
    return Promise.resolve();
  }

  cancelConnect(): void {
    this.store.setFlow(CLOSED_FLOW);
  }

  flowAction(): void {}

  listConnectableWallets(): ConnectableWallet[] {
    return [];
  }

  disconnect(): void {}

  getConnectFlow(): ConnectFlow {
    return this.store.getFlow();
  }

  subscribeConnectFlow(listener: (flow: ConnectFlow) => void): () => void {
    return this.store.subscribeFlow(listener);
  }

  getSession(): WalletSession {
    return this.store.getSession();
  }

  subscribeSession(listener: (session: WalletSession) => void): () => void {
    return this.store.subscribeSession(listener);
  }

  getWalletClient(): Promise<WalletClient> {
    return Promise.reject(new Error(WALLETLESS_VOICE));
  }

  switchChain(): Promise<void> {
    return Promise.reject(new Error(WALLETLESS_VOICE));
  }
}
