/**
 * The auth adapter's shared mutable core. The AuthPort implementation and
 * the Privy bridge both live here (the bridge drives Privy's React hooks,
 * the port is React-free), and this store is the state they share: one
 * WalletSession snapshot and one ConnectFlow, each with frozen references
 * between changes so useSyncExternalStore's Object.is comparison stays
 * stable and hydration sees the same constants the server rendered.
 */

import type { ConnectFlow, WalletSession } from "@/domain/types";

/** The one disconnected session — the server + pre-ready snapshot. */
export const DISCONNECTED_SESSION: WalletSession = Object.freeze({
  status: "idle",
  did: null,
  address: null,
  walletKind: null,
  walletLabel: null,
  chainId: null,
  networkOk: null,
  syncState: "idle",
  closedReason: null,
});

/** The one closed flow. */
export const CLOSED_FLOW: ConnectFlow = Object.freeze({ step: "closed" });

export class SessionStore {
  private sessionListeners = new Set<(session: WalletSession) => void>();
  private flowListeners = new Set<(flow: ConnectFlow) => void>();
  private session: WalletSession = DISCONNECTED_SESSION;
  private flow: ConnectFlow = CLOSED_FLOW;

  getSession(): WalletSession {
    return this.session;
  }

  subscribeSession(listener: (session: WalletSession) => void): () => void {
    this.sessionListeners.add(listener);
    return () => {
      this.sessionListeners.delete(listener);
    };
  }

  /**
   * Merge a patch into the session snapshot. Listeners fire only when a
   * value actually changed — provider events (chainChanged and friends) can
   * repeat, and each notify is a React re-render.
   */
  setSession(patch: Partial<WalletSession>): void {
    const current = this.session;
    const next = { ...current, ...patch };
    for (const key of Object.keys(patch) as (keyof WalletSession)[]) {
      if (current[key] !== next[key]) {
        this.session = next;
        for (const listener of this.sessionListeners) listener(next);
        return;
      }
    }
  }

  getFlow(): ConnectFlow {
    return this.flow;
  }

  subscribeFlow(listener: (flow: ConnectFlow) => void): () => void {
    this.flowListeners.add(listener);
    return () => {
      this.flowListeners.delete(listener);
    };
  }

  /** Replace the flow snapshot; skips notify when nothing changed. */
  setFlow(flow: ConnectFlow): void {
    if (sameFlow(this.flow, flow)) return;
    this.flow = flow;
    for (const listener of this.flowListeners) listener(flow);
  }
}

/** Shallow equality over the flow union's one level of fields. */
function sameFlow(a: ConnectFlow, b: ConnectFlow): boolean {
  if (a.step !== b.step) return false;
  if (a.step === "closed" || b.step === "closed") return true;
  for (const key of Object.keys(b) as (keyof typeof b)[]) {
    if (a[key as keyof typeof a] !== b[key]) return false;
  }
  return true;
}
