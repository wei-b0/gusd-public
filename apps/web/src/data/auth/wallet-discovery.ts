/**
 * EIP-6963 wallet discovery. External wallets connect app-owned: the app
 * asks the browser for injected providers, keeps what announces itself, and
 * never hands the interaction to a third-party modal. Privy's SIWE login
 * then authenticates the connected address — the wallet stays ours end to
 * end.
 */

import type { EIP1193Provider } from "@privy-io/react-auth";

/** One announced (or legacy-injected) browser wallet. */
export interface DiscoveredWallet {
  /** Product key for the connect dialog: "metamask", "rabby", "injected". */
  id: string;
  /** The wallet's own display name. */
  label: string;
  /** EIP-6963 rdns when announced; null for the legacy fallback. */
  rdns: string | null;
  provider: EIP1193Provider;
}

let started = false;
const discovered = new Map<string, DiscoveredWallet>();
const discoveryListeners = new Set<() => void>();

/** Known rdns → product id. Unknown wallets slug their rdns or name. */
function walletIdFor(rdns: string | null, name: string): string {
  const known: Record<string, string> = {
    "io.metamask": "metamask",
    "io.metamask.flask": "metamask",
    "io.rabby": "rabby",
  };
  if (rdns && known[rdns]) return known[rdns];
  if (rdns) return rdns.split(".").pop()!.toLowerCase();
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Start listening (idempotent, browser only) and request announcements. */
export function startWalletDiscovery(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("eip6963:announceProvider", (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (!detail?.info || !detail?.provider) return;
    const { uuid, name, rdns } = detail.info as { uuid: string; name: string; rdns?: string };
    const wallet: DiscoveredWallet = {
      id: walletIdFor(rdns ?? null, name),
      label: name,
      rdns: rdns ?? null,
      provider: detail.provider as EIP1193Provider,
    };
    discovered.set(uuid, wallet);
    for (const listener of discoveryListeners) listener();
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/** Everything announced so far. Announcements may keep arriving. */
export function listDiscoveredWallets(): DiscoveredWallet[] {
  startWalletDiscovery();
  return [...discovered.values()];
}

/** Subscribe to announcement changes — the connect dialog's re-render tick. */
export function subscribeWalletDiscovery(listener: () => void): () => void {
  startWalletDiscovery();
  discoveryListeners.add(listener);
  return () => {
    discoveryListeners.delete(listener);
  };
}

/**
 * The legacy injected provider — what the connect flow falls back to when
 * nothing announced itself (older extensions, some mobile browsers).
 */
export function injectedFallback(): DiscoveredWallet | null {
  if (typeof window === "undefined") return null;
  const ethereum = (window as { ethereum?: EIP1193Provider }).ethereum;
  if (!ethereum) return null;
  return { id: "injected", label: "Browser wallet", rdns: null, provider: ethereum };
}
