/**
 * The indexed wallet-activity store — routed executions, raw protocol
 * events, and the sgUSD vault position for the connected wallet, from
 * /v1/protocol/wallets/*. Wallet-scoped singleton, no timer: it loads once
 * per address (ensure on first subscribe), refreshes on demand (the
 * reconciler calls it after a confirmed transaction), and pages on user
 * request ("Load earlier", hard-capped).
 *
 * Fail-soft doctrine: every fetch keeps its prior slice on failure and the
 * store never throws; a slice that hasn't landed is empty, never an error
 * surfaced to the UI. Without the indexer configured (no client) the store
 * is inert — every fetch no-ops and the state stays empty.
 */

import { useSyncExternalStore } from "react";
import type { IndexedEvent } from "@/domain/indexer";
import type { ExecutionDto, WalletVaultPositionDto } from "./dto";
import { getProtocolClient, type ProtocolClient } from "./client";

/** Page size for both streams — the UI shows a page at a glance. */
const PAGE_LIMIT = 25;
/** Hard cap on "Load earlier" pages per stream per session — bounded
 *  state, and five pages of history is plenty for a wallet desk. */
const MAX_PAGES = 5;

export interface IndexedActivityState {
  /** The bound wallet (lowercase); null means no session — reads skip. */
  address: string | null;
  /** Wall-clock the last load finished at; null before the first load. */
  loadedAt: number | null;
  /** Routed executions, newest first (wire order). */
  executions: readonly ExecutionDto[];
  /** Raw protocol events, newest first (wire order). */
  events: readonly IndexedEvent[];
  /** The wallet's sgUSD vault position, null when none or not landed. */
  vaultPosition: WalletVaultPositionDto | null;
  /** Whether an older page plausibly exists for each stream. */
  hasMoreExecutions: boolean;
  hasMoreEvents: boolean;
  loading: boolean;
  version: number;
}

const EMPTY: IndexedActivityState = {
  address: null,
  loadedAt: null,
  executions: [],
  events: [],
  vaultPosition: null,
  hasMoreExecutions: false,
  hasMoreEvents: false,
  loading: false,
  version: 0,
};

export class IndexedActivityStore {
  private state: IndexedActivityState = EMPTY;
  private listeners = new Set<() => void>();
  private execCursor: string | null = null;
  private eventCursor: string | null = null;
  private execPages = 0;
  private eventPages = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly client: ProtocolClient | null,
    private readonly now: () => number = Date.now,
  ) {}

  get(): IndexedActivityState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    const first = this.listeners.size === 0;
    this.listeners.add(listener);
    if (first) void this.ensureLoaded();
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Bind a wallet. Clears the old wallet's rows and loads the new one;
   *  null (logout) just clears. */
  setAddress(address: string | null): void {
    const next = address === null ? null : address.toLowerCase();
    if (next !== null && next === this.state.address) return;
    this.execCursor = null;
    this.eventCursor = null;
    this.execPages = 0;
    this.eventPages = 0;
    this.state = { ...EMPTY, address: next, version: this.state.version + 1 };
    this.emit();
    if (next !== null) void this.load();
  }

  /**
   * Reload everything for the bound wallet. The three fetches are
   * independent: a failed slice keeps its prior rows, and a fully failed
   * load still clears `loading` — the reconciler calls this after every
   * confirmed transaction, so failures must never wedge it.
   */
  async refresh(): Promise<void> {
    await this.load();
  }

  /** One more (older) page of routed executions, or nothing at the cap. */
  async loadMoreExecutions(): Promise<void> {
    const address = this.state.address;
    if (address === null || !this.state.hasMoreExecutions) return;
    if (this.execPages >= MAX_PAGES) return;
    this.execPages += 1;
    const client = this.client;
    if (client === null || this.execCursor === null) return;
    try {
      const body = await client.getWalletExecutions(address, {
        limit: PAGE_LIMIT,
        cursor: this.execCursor,
      });
      this.state = {
        ...this.state,
        executions: mergeById(this.state.executions, body.executions, execKey),
        hasMoreExecutions: body.nextCursor !== undefined,
        version: this.state.version + 1,
      };
      this.execCursor = body.nextCursor ?? null;
      this.emit();
    } catch {
      // keep prior rows — null doctrine
    }
  }

  /** One more (older) page of raw protocol events, or nothing at the cap. */
  async loadMoreEvents(): Promise<void> {
    const address = this.state.address;
    if (address === null || !this.state.hasMoreEvents) return;
    if (this.eventPages >= MAX_PAGES) return;
    this.eventPages += 1;
    const client = this.client;
    if (client === null || this.eventCursor === null) return;
    try {
      const body = await client.getUserEvents(address, {
        limit: PAGE_LIMIT,
        cursor: this.eventCursor,
      });
      this.state = {
        ...this.state,
        events: mergeById(this.state.events, body.events, eventKey),
        hasMoreEvents: body.nextCursor !== undefined,
        version: this.state.version + 1,
      };
      this.eventCursor = body.nextCursor ?? null;
      this.emit();
    } catch {
      // keep prior rows — null doctrine
    }
  }

  // -- internals ----------------------------------------------------------------

  /** Load once per address: the first subscription (or setAddress) runs it;
   *  concurrent calls share one pass. */
  private async ensureLoaded(): Promise<void> {
    if (this.state.address === null) return;
    if (this.state.loadedAt !== null) return;
    await this.load();
  }

  private async load(): Promise<void> {
    const address = this.state.address;
    const client = this.client;
    if (address === null || client === null) return;
    if (this.inflight) return this.inflight;
    this.state = { ...this.state, loading: true, version: this.state.version + 1 };
    this.emit();
    this.inflight = (async () => {
      const [executions, events, positions] = await Promise.allSettled([
        client.getWalletExecutions(address, { limit: PAGE_LIMIT }),
        client.getUserEvents(address, { limit: PAGE_LIMIT }),
        client.getWalletPositions(address),
      ]);
      // Each landed slice replaces its stream; a failed slice keeps its
      // prior rows. loadedAt marks the pass so effects can key on it.
      let landed = 0;
      // A mid-flight setAddress (logout, wallet switch) owns the state now —
      // never apply this pass's rows onto another wallet's snapshot.
      if (this.state.address !== address) {
        this.inflight = null;
        return;
      }
      let next: IndexedActivityState = { ...this.state, loading: false };
      if (executions.status === "fulfilled") {
        landed += 1;
        next = {
          ...next,
          executions: executions.value.executions,
          hasMoreExecutions: executions.value.nextCursor !== undefined,
        };
        this.execCursor = executions.value.nextCursor ?? null;
      }
      if (events.status === "fulfilled") {
        landed += 1;
        next = {
          ...next,
          events: events.value.events,
          hasMoreEvents: events.value.nextCursor !== undefined,
        };
        this.eventCursor = events.value.nextCursor ?? null;
      }
      if (positions.status === "fulfilled") {
        landed += 1;
        next = { ...next, vaultPosition: positions.value.vault };
      }
      // Page budget resets on every full load — a fresh refresh re-earns
      // its "Load earlier" pages.
      this.execPages = 0;
      this.eventPages = 0;
      next = {
        ...next,
        loadedAt: landed > 0 ? this.now() : this.state.loadedAt,
        version: this.state.version + 1,
      };
      this.state = next;
      this.inflight = null;
      this.emit();
    })();
    return this.inflight;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Newest-first wire pages; append older pages dropping rows already held. */
function mergeById<T>(held: readonly T[], page: readonly T[], key: (row: T) => string): readonly T[] {
  const seen = new Set(held.map(key));
  const older = page.filter((row) => !seen.has(key(row)));
  return older.length === 0 ? held : [...held, ...older];
}

function execKey(e: ExecutionDto): string {
  return `${e.chainId}:${e.txHash.toLowerCase()}:${e.logIndex}`;
}

function eventKey(e: IndexedEvent): string {
  return `${e.chainId}:${e.txHash.toLowerCase()}:${e.logIndex}`;
}

// --- singleton seam ---------------------------------------------------------------

let singleton: IndexedActivityStore | null = null;

/** The shared wallet-activity store. Created with the protocol client (or
 *  without one — then it is inert until a client exists at fetch time). */
export function getIndexedActivityStore(): IndexedActivityStore {
  if (singleton === null) {
    singleton = new IndexedActivityStore(getProtocolClient());
  }
  return singleton;
}

/** Test seam: drop the singleton so a suite starts clean. */
export function disposeIndexedActivityStore(): void {
  singleton = null;
}

/** React seam over the wallet-activity store — mirrors useOnchainAccount. */
export function useIndexedActivity(store: IndexedActivityStore): IndexedActivityState {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.get(),
    () => store.get(),
  );
}
