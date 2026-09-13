/**
 * The interim onchain account store — this session's wallet state read
 * straight from the contracts: balances and GPU positions.
 *
 * Successor, by design: the Envio indexer (src/domain/indexer.ts) replaces
 * these direct reads with indexed events once it ships. Until then this
 * store is the one place that turns the chain into user state, so desks,
 * presets, and the portfolio read one snapshot instead of each firing their
 * own balanceOf. It is still NOT a display-price source and never a market
 * data source — balances and positions only.
 *
 * useSyncExternalStore-ready: get() returns a frozen snapshot whose
 * reference only changes when state actually changes.
 */

import { useEffect, useSyncExternalStore } from "react";
import type { AssetId } from "@/domain/types";
import { assetForGpuId } from "@/data/web3/gpu-id";
import { contractReads } from "@/data/web3/reads";
import { contractReadsWithIndexer } from "@/data/web3/reads-protocol";
import { getActiveChain } from "@/data/web3/chains";
import { basisNumber } from "@/data/protocol/map";

/** One GPU position held in the connected wallet (18-dec product size). */
export interface OnchainPosition {
  gpuId: `0x${string}`;
  /** The product asset this gpuId settles, when the catalog knows it. */
  asset: AssetId | null;
  token: string;
  size: number;
  /** gUSD per whole GPU from the indexed basis — null unless complete. */
  avgEntry: number | null;
  /** Realized PnL (gUSD) from the indexed basis — null unless complete. */
  realizedPnl: number | null;
  /** The indexer's gate reason when the basis fields are null. */
  basisReason: string | null;
}

export interface OnchainAccountSnapshot {
  /** The bound signer; null means no session — reads are skipped. */
  address: string | null;
  /** Wall-clock the snapshot was read at; null before the first refresh. */
  loadedAt: number | null;
  chainId: number;
  gUsd: number;
  stable: number;
  sGusd: number;
  positions: readonly OnchainPosition[];
}

const EMPTY: OnchainAccountSnapshot = {
  address: null,
  loadedAt: null,
  chainId: 0,
  gUsd: 0,
  stable: 0,
  sGusd: 0,
  positions: [],
};

/** Poll interval while a session is active and the tab is visible. */
const POLL_MS = 30_000;

export class OnChainAccountStore {
  private snapshot: OnchainAccountSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;
  /** Set at the first failed refresh of an outage; one line per outage. */
  private outageLogged = false;

  constructor(private readonly now: () => number = Date.now) {}

  get(): OnchainAccountSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Bind the session's signer. Null (logout) clears to the empty snapshot;
   * an address triggers an immediate refresh and starts polling.
   */
  setAddress(address: string | null): void {
    if (address === this.snapshot.address) return;
    this.stopPolling();
    if (!address) {
      this.set(EMPTY);
      return;
    }
    this.set({ ...EMPTY, address, chainId: getActiveChain().id });
    void this.refresh();
    this.startPolling();
  }

  /**
   * Re-read every balance and position. `directBalances` reads the token
   * balances straight from the contracts, bypassing the indexer — the
   * post-confirmation state the indexer may not have ingested yet (the
   * reconciler passes it at confirm time). Positions stay on the indexed
   * seam so the basis columns keep their enrichment.
   */
  async refresh(opts?: { directBalances?: boolean }): Promise<void> {
    const address = this.snapshot.address;
    if (!address || this.refreshing) return this.refreshing ?? Promise.resolve();
    this.refreshing = (async () => {
      try {
        // State reads via the indexed seam (RPC fallback inside); the
        // execution paths below keep their own direct reads.
        const indexed = contractReadsWithIndexer();
        const reads = opts?.directBalances
          ? { ...indexed, balances: contractReads().balances }
          : indexed;
        const chainId = getActiveChain().id;
        const [balances, positions] = await Promise.all([
          reads.balances(address as `0x${string}`),
          reads.positions(address as `0x${string}`),
        ]);
        // A stale refresh (session switched mid-flight) must not land.
        if (this.snapshot.address !== address) return;
        this.set({
          address,
          chainId,
          loadedAt: this.now(),
          gUsd: balances.gUsd,
          stable: balances.stable,
          sGusd: balances.sGusd,
          positions: positions.map((p) => ({
            gpuId: p.gpuId,
            asset: assetForGpuId(p.gpuId),
            token: p.token,
            size: p.size,
            avgEntry: basisNumber(p.avgEntryRaw),
            realizedPnl: basisNumber(p.realizedPnlGusdRaw),
            basisReason: p.basisReason ?? null,
          })),
        });
        this.outageLogged = false;
      } catch (err) {
        // Read failure is a system problem, not a user failure: keep the
        // last snapshot. One line per outage — the poll loop would otherwise
        // re-log viem's full wall-of-text every 30s (a photobombed console
        // is a broken console); recovery resets silently.
        if (!this.outageLogged) {
          this.outageLogged = true;
          const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
          console.error(
            `[account-store] refresh failed — RPC unreachable on chain ${getActiveChain().id}? Is the node up? (${reason.slice(0, 160)})`,
          );
        }
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** Drop balances/positions (an action confirmed) and re-read. */
  invalidate(): void {
    void this.refresh();
  }

  private set(next: OnchainAccountSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  private startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void this.refresh();
      }
    }, POLL_MS);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
    }
  }

  private stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
  }

  private onVisibility = (): void => {
    if (document.visibilityState === "visible" && this.snapshot.address) void this.refresh();
  };
}

/** The session-wide store. One wallet, one store. */
let singleton: OnChainAccountStore | null = null;

export function getOnchainAccountStore(): OnChainAccountStore {
  singleton ??= new OnChainAccountStore();
  return singleton;
}

/** Test seam: drop the singleton so a suite starts clean. */
export function disposeOnchainAccountStore(): void {
  singleton = null;
}

/** React seam: the frozen account snapshot. */
export function useOnchainAccount(store: OnChainAccountStore): OnchainAccountSnapshot {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.get(),
    () => store.get(),
  );
}
