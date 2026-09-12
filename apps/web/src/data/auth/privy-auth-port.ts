/**
 * The real AuthPort. One session, one wallet, one signer — whatever the
 * wallet's origin. External wallets connect app-owned (EIP-6963 discovery +
 * eth_requestAccounts here, SIWE via the bridge's Privy hooks); embedded
 * wallets arrive from Privy's useWallets. Both normalize to an EIP-1193
 * provider attached below, which is the only signer source this port knows.
 *
 * Privy work that requires React hooks (login flows, logout, embedded
 * provisioning) is requested from the bridge through intents — see
 * privy-bridge.tsx. The port itself never imports Privy's React surface.
 */

import type { EIP1193Provider } from "@privy-io/react-auth";
import type { WalletClient } from "viem";
import type { AuthPort } from "@/domain/ports";
import type {
  ConnectAction,
  ConnectFlow,
  ConnectableWallet,
  SessionSyncState,
  WalletKind,
  WalletSession,
} from "@/domain/types";
import { getActiveChain, chainAddParams, chainCaip2From, signableChain } from "@/data/web3/chains";
import { createWalletClientFromProvider, isUserRejection } from "@/data/web3/wallet-client";
import { CLOSED_FLOW, DISCONNECTED_SESSION, SessionStore } from "./session-store";
import {
  injectedFallback,
  listDiscoveredWallets,
  startWalletDiscovery,
  type DiscoveredWallet,
} from "./wallet-discovery";

/** Work only the bridge (with Privy's React hooks) can execute. */
export type AuthIntent =
  | { type: "email-code"; email: string }
  | { type: "email-verify"; code: string }
  | { type: "email-resend"; email: string }
  | { type: "google" }
  | { type: "siwe-sign"; walletId: string; label: string; provider: EIP1193Provider; address: string }
  | { type: "logout" };

/** A wallet the bridge attached as THE session signer. */
export interface AttachedWallet {
  /** Lowercase hex address. */
  address: string;
  walletKind: WalletKind;
  /** Display name ("MetaMask", "Privy"); null when unknown. */
  walletLabel: string | null;
  provider: EIP1193Provider;
  /** CAIP-2 chain the wallet reported, when known synchronously. */
  chainId?: string | null;
  /**
   * Managed-wallet chain switch (embedded wallets switch through Privy, not
   * the raw provider). External wallets switch through the provider below.
   */
  switchManaged?: (chainIdHex: string) => Promise<void>;
}

const PRODUCT_ERRORS = {
  connectDeclined: "Connect declined. Pick the wallet again to continue.",
  connectFailed: "The wallet didn't connect. Try again in a moment.",
  signatureDeclined: "Signature declined. Connect again to continue.",
  signatureFailed: "The signature didn't go through. Try again in a moment.",
  signatureWrongAccount: "The wallet signed with a different account. Connect again and confirm the request.",
  noAnswer: "No wallet answered the connect request.",
  noAccount: "The wallet returned no account. Unlock it and try again.",
} as const;

function caip2(chainId: number): string {
  return `eip155:${chainId}`;
}

function chainFromCaip2(caip: string | null): number | null {
  if (!caip?.startsWith("eip155:")) return null;
  const id = Number(caip.slice("eip155:".length));
  return Number.isInteger(id) && id >= 0 ? id : null;
}

export class PrivyAuthPort implements AuthPort {
  /** The bridge writes flow transitions for async work through this. */
  readonly store = new SessionStore();

  private intentListeners = new Set<(intent: AuthIntent) => void>();
  private attached: AttachedWallet | null = null;

  // -- AuthPort -------------------------------------------------------------

  /** Open the connect flow — the dialog is a view of it. Never blocks. */
  async connect(): Promise<void> {
    startWalletDiscovery();
    this.store.setFlow({ step: "method", error: null });
  }

  cancelConnect(): void {
    this.store.setFlow(CLOSED_FLOW);
  }

  flowAction(action: ConnectAction): void {
    switch (action.type) {
      case "submit-email": {
        const email = action.email.trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          this.store.setFlow({ step: "method", error: "That doesn't look like an email address." });
          return;
        }
        this.store.setFlow({ step: "email", email, busy: true, error: null });
        this.emit({ type: "email-code", email });
        return;
      }
      case "submit-code": {
        const flow = this.store.getFlow();
        if (flow.step !== "email") return;
        this.store.setFlow({ step: "email", email: flow.email, busy: true, error: null });
        this.emit({ type: "email-verify", code: action.code });
        return;
      }
      case "resend-code": {
        const flow = this.store.getFlow();
        if (flow.step !== "email") return;
        this.store.setFlow({ step: "email", email: flow.email, busy: true, error: null });
        this.emit({ type: "email-resend", email: flow.email });
        return;
      }
      case "back-to-method":
        this.store.setFlow({ step: "method", error: null });
        return;
      case "choose-google":
        this.store.setFlow({ step: "oauth", provider: "google", error: null });
        this.emit({ type: "google" });
        return;
      case "choose-wallet":
        this.connectExternal(action.walletId);
        return;
    }
  }

  listConnectableWallets(): ConnectableWallet[] {
    const wallets = listDiscoveredWallets().map((w) => ({ id: w.id, label: w.label }));
    if (wallets.length === 0) {
      const fallback = injectedFallback();
      if (fallback) wallets.push({ id: fallback.id, label: fallback.label });
    }
    return wallets;
  }

  disconnect(): void {
    this.endSession("user");
    this.emit({ type: "logout" });
  }

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

  async getWalletClient(chainId: number): Promise<WalletClient> {
    const session = this.store.getSession();
    if (session.status !== "connected" || !this.attached) {
      throw new Error("Connect a wallet first — nothing signs without one.");
    }
    const active = getActiveChain();
    const chain = signableChain(chainId);
    if (chain === null) {
      throw new Error(`This desk trades on ${active.name} — no signer for chain ${chainId}.`);
    }
    const walletChain = chainFromCaip2(session.chainId);
    if (chainId === active.id) {
      if (walletChain !== null && walletChain !== active.id) {
        throw new Error(`The wallet is on another network — switch it to ${active.name} and try again.`);
      }
    } else if (walletChain !== chainId) {
      // An origin leg: the bridge switches first and a landed switch is
      // recorded below — a session still reporting the desk's chain means
      // the switch was declined or never happened.
      throw new Error(
        "The bridge needs the wallet on the origin chain — start the funding flow again and approve the network switch.",
      );
    }
    const key = `${this.attached.address}:${chainId}`;
    const existing = this.clients.get(key);
    if (existing) return existing;
    const client = createWalletClientFromProvider({
      address: this.attached.address,
      provider: this.attached.provider,
      chain,
    });
    this.clients.set(key, client);
    return client;
  }

  async switchChain(chainId: number): Promise<void> {
    const wallet = this.attached;
    if (!wallet) throw new Error("Connect a wallet first — there is no network to switch.");
    const active = getActiveChain();
    // The desk's own chain always; a bridge origin while the desk serves
    // funding (signableChain is the one definition of "off-desk but
    // signable"). Anything else has no product surface that would ask.
    if (signableChain(chainId) === null) {
      throw new Error(`This desk only switches to ${active.name}.`);
    }
    const hex = `0x${chainId.toString(16)}` as `0x${string}`;
    try {
      if (wallet.switchManaged) {
        await wallet.switchManaged(hex);
      } else {
        await request(wallet.provider, "wallet_switchEthereumChain", [{ chainId: hex }]);
      }
    } catch (err) {
      // 4902 (or its textual variants): the wallet doesn't know the chain —
      // add it, which also switches. Managed wallets handle their own adds.
      if (!wallet.switchManaged && isUnrecognizedChainError(err)) {
        const params = chainAddParams(chainId);
        if (params === null) {
          // Unreachable through the signableChain gate (every servable chain
          // carries add params) — fail closed as an ordinary switch failure.
          throw new Error("The network switch didn't go through. Try again in a moment.");
        }
        await request(wallet.provider, "wallet_addEthereumChain", [params]);
        // Fall through to the session record below — an added chain is a
        // landed switch, event or no event.
      } else {
        if (isUserRejection(err)) return; // the wallet stayed where it was
        throw new Error("The network switch didn't go through. Try again in a moment.");
      }
    }
    // Record where the wallet now sits. Managed (embedded) wallets don't
    // re-announce through the provider, and both the network strip and the
    // bridge's origin-leg signer check read this field — a landed switch
    // that the session never hears about reads as a declined one.
    this.setChainCaip2(caip2(chainId));
  }

  // -- bridge channels ------------------------------------------------------

  /** Privy work the bridge executes; see AuthIntent. */
  onIntent(listener: (intent: AuthIntent) => void): () => void {
    this.intentListeners.add(listener);
    return () => {
      this.intentListeners.delete(listener);
    };
  }

  /** The bridge pushes the Privy DID once authenticated. */
  setDid(did: string | null): void {
    const session = this.store.getSession();
    if (!did) return; // session end flows through endSession, not setDid(null)
    if (session.status === "idle") {
      this.store.setSession({ did, status: "connecting", closedReason: null });
    } else {
      this.store.setSession({ did });
    }
  }

  /** Backend identity-sync progress (see SessionSyncState). */
  markSync(state: SessionSyncState): void {
    this.store.setSession({ syncState: state });
  }

  /** True when this exact wallet is already the attached signer. */
  hasAttached(address: string): boolean {
    return this.attached?.address === address && this.store.getSession().status === "connected";
  }

  /**
   * Attach THE wallet — the normalization point. Any origin collapses into
   * a provider + address here; everything downstream reads only this shape.
   */
  attachWallet(wallet: AttachedWallet): void {
    this.detachProvider();
    this.attached = wallet;
    this.clients.clear();
    this.providerRef = wallet.provider;
    this.providerEvents = {
      chainChanged: (cid: unknown) => this.setChainCaip2(String(cid)),
      accountsChanged: (accounts: unknown) => {
        const list = (accounts as string[] | undefined)?.map((a) => a.toLowerCase()) ?? [];
        // A different address is a different wallet — under one user = one
        // wallet, this session is over. An empty list is a lock/disconnect.
        if (!list.includes(wallet.address)) this.walletChanged();
      },
    };
    wallet.provider.on?.("chainChanged", this.providerEvents.chainChanged);
    wallet.provider.on?.("accountsChanged", this.providerEvents.accountsChanged);
    this.store.setSession({
      status: "connected",
      address: wallet.address,
      walletKind: wallet.walletKind,
      walletLabel: wallet.walletLabel,
      chainId: wallet.chainId ?? null,
      networkOk:
        wallet.chainId == null ? null : chainFromCaip2(wallet.chainId) === getActiveChain().id,
      closedReason: null,
    });
    // Externals don't report their chain synchronously — ask once, quietly.
    if (wallet.chainId == null) {
      request(wallet.provider, "eth_chainId")
        .then((cid) => this.setChainCaip2(String(cid)))
        .catch(() => {});
    }
  }

  /**
   * Silent re-attach after a reload: find an announced (or injected)
   * provider that already reports this address via eth_accounts — no
   * prompts. Null means the wallet is gone from this browser.
   */
  async restoreExternal(address: string): Promise<DiscoveredWallet | null> {
    startWalletDiscovery();
    const candidates = [...listDiscoveredWallets()];
    const fallback = injectedFallback();
    if (fallback && !candidates.some((c) => c.provider === fallback.provider)) {
      candidates.push(fallback);
    }
    for (const candidate of candidates) {
      try {
        const accounts = (await request(candidate.provider, "eth_accounts")) as string[] | undefined;
        if (accounts?.some((a) => a.toLowerCase() === address)) return candidate;
      } catch {
        // A wallet refusing eth_accounts is skipped, not fatal.
      }
    }
    return null;
  }

  /**
   * End the session. `user` is a plain exit, `wallet-changed` means the
   * signer changed identity (one user = one wallet: that session is over),
   * `expired` means Privy ended the auth session out-of-band.
   */
  endSession(reason: "user" | "wallet-changed" | "expired"): void {
    this.detachProvider();
    this.attached = null;
    this.clients.clear();
    this.store.setFlow(CLOSED_FLOW);
    this.store.setSession({
      ...DISCONNECTED_SESSION,
      closedReason: reason,
    });
  }

  // -- internals ------------------------------------------------------------

  private clients = new Map<string, WalletClient>();
  private providerRef: EIP1193Provider | null = null;
  private providerEvents: {
    chainChanged: (chainId: unknown) => void;
    accountsChanged: (accounts: unknown) => void;
  } | null = null;

  private detachProvider(): void {
    if (this.providerRef && this.providerEvents) {
      this.providerRef.removeListener?.("chainChanged", this.providerEvents.chainChanged);
      this.providerRef.removeListener?.("accountsChanged", this.providerEvents.accountsChanged);
    }
    this.providerRef = null;
    this.providerEvents = null;
  }

  private connectExternal(walletId: string): void {
    const wallet = this.resolveWalletById(walletId);
    if (!wallet) {
      this.store.setFlow({ step: "wallet", walletLabel: null, error: PRODUCT_ERRORS.noAnswer });
      return;
    }
    this.store.setFlow({ step: "wallet", walletLabel: wallet.label, error: null });
    // The app owns the connect: request accounts from the provider itself.
    request(wallet.provider, "eth_requestAccounts")
      .then((accounts) => {
        const address = (accounts as string[] | undefined)?.[0];
        if (!address) {
          // Resolved, but empty: the wallet is locked or refused silently.
          this.store.setFlow({
            step: "wallet",
            walletLabel: wallet.label,
            error: PRODUCT_ERRORS.noAccount,
          });
          return;
        }
        this.store.setFlow({ step: "signature", walletLabel: wallet.label, error: null });
        this.emit({
          type: "siwe-sign",
          walletId: wallet.id,
          label: wallet.label,
          provider: wallet.provider,
          address,
        });
      })
      .catch((err: unknown) => {
        // The provider's own reason lands in the console — the amber box
        // keeps the product voice, this line keeps us diagnosable.
        console.error(`[connect] ${wallet.label} refused eth_requestAccounts:`, err);
        this.store.setFlow({
          step: "wallet",
          walletLabel: wallet.label,
          error: isUserRejection(err) ? PRODUCT_ERRORS.connectDeclined : PRODUCT_ERRORS.connectFailed,
        });
      });
  }

  private resolveWalletById(walletId: string): DiscoveredWallet | null {
    const discovered = listDiscoveredWallets().find((w) => w.id === walletId);
    if (discovered) return discovered;
    if (walletId === "injected") return injectedFallback();
    return null;
  }

  /**
   * Record the wallet's chain. The wire form varies — hex quantities from
   * raw providers (eth_chainId, chainChanged), CAIP-2 from Privy's managed
   * wallets — and normalizes here, so networkOk actually flips when the
   * wallet sits on (or switches to) a foreign chain.
   */
  private setChainCaip2(value: string | null): void {
    const caip = chainCaip2From(value);
    this.store.setSession({
      chainId: caip,
      networkOk: caip == null ? null : chainFromCaip2(caip) === getActiveChain().id,
    });
  }

  private walletChanged(): void {
    this.endSession("wallet-changed");
    this.emit({ type: "logout" });
  }

  private emit(intent: AuthIntent): void {
    for (const listener of this.intentListeners) listener(intent);
  }
}

/** Typed window over EIP-1193 request. */
function request(
  provider: EIP1193Provider,
  method: string,
  params?: unknown[],
): Promise<unknown> {
  return provider.request({ method, params });
}

/** EIP-1193 4902 and its textual variants (some wallets throw strings). */
function isUnrecognizedChainError(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (code === 4902) return true;
    const data = (err as { data?: { originalError?: { code?: unknown } } }).data;
    if (data?.originalError?.code === 4902) return true;
  }
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /unrecognized chain|not (been )?added|add(ing)? (the )?chain/i.test(message);
}

export { PRODUCT_ERRORS };
