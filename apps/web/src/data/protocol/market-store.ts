/**
 * The indexed protocol market store — pool state, the AMM swap tape, hourly
 * pool stats, and oracle publication state, polled from /v1/protocol/*.
 *
 * Fail-soft doctrine: "null means not ready, never error". Every read keeps
 * its prior value on a failed fetch; the store never throws and never
 * surfaces a transport failure to the UI.
 *
 * Snapshot identity follows the house stores (frozen slices, version bumped
 * on change); selector results cache against the underlying slice so
 * useSyncExternalStore sees Object.is-stable values between polls.
 *
 * Created ONLY when the indexer is configured and DATA_SOURCE === "oracle"
 * (see enabled.ts) — mock market mode never gets one, so its injected
 * market stays the whole world.
 *
 * Lazy reads fetch only in a live browser (`canFetch`): on the server every
 * read stays cold, so the SSR render and the client's first hydration agree
 * — a warmed server singleton would render figures a cold client can't
 * match. The poll loop already runs only under a subscriber (an effect,
 * therefore client-only).
 */

import type { AssetId, MarketTrade } from "@/domain/types";
import { assetForGpuId, gpuIdForAsset } from "@/data/web3/gpu-id";
import { inRangeGusdDepth, swapToMarketTrade, trades24h, volume24hGusd } from "./map";
import type { GpuAssetDto, OracleStateDto, PoolDto, PoolStatsBucketDto, StatsBody, SwapTapeDto } from "./dto";
import { getProtocolClient, type ProtocolClient } from "./client";

/** Oldest-first ring per pool: the port contract serves oldest-first and
 *  the cap keeps a long session bounded. */
const SWAP_CAP = 60;
const POLL_MS = 30_000;
/** Cooldown for lazy one-off fetches (hourly buckets, oracle state, gpus). */
const COOLDOWN_MS = 30_000;
/** The only 24h window the store serves. */
const DAY_SEC = 86_400;

export interface ProtocolMarketState {
  /** Pool rows by poolId. */
  pools: Readonly<Record<string, PoolDto>>;
  /** GPU asset rows by lowercase gpuId (asset→pool resolution). */
  gpus: Readonly<Record<string, GpuAssetDto>>;
  /** Swap tape per pool, OLDEST-FIRST (port contract), capped. */
  swaps: Readonly<Record<string, readonly SwapTapeDto[]>>;
  /** Hourly buckets per pool with the window they were fetched for. */
  hourly: Readonly<Record<string, { fromSec: number; buckets: readonly PoolStatsBucketDto[] }>>;
  /** Indexed oracle publication state per lowercase gpuId. */
  oracleState: Readonly<Record<string, OracleStateDto | null>>;
  /** Protocol aggregates + the sgUSD vault (either may be null pre-data). */
  stats: StatsBody | null;
  version: number;
}

const EMPTY_STATE: ProtocolMarketState = {
  pools: {},
  gpus: {},
  swaps: {},
  hourly: {},
  oracleState: {},
  stats: null,
  version: 0,
};

interface Traded {
  /** The tape the rows were computed from (identity check). */
  swaps: readonly SwapTapeDto[];
  /** Typed mutable to satisfy the MarketDataPort contract; the array is a
   *  cached stable ref and nothing downstream mutates it. */
  trades: MarketTrade[];
}
interface Bucketed {
  /** The buckets the figure was computed from (identity check). */
  buckets: readonly PoolStatsBucketDto[];
  value: number;
}

export class ProtocolMarketStore {
  private state: ProtocolMarketState = EMPTY_STATE;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPollAt = 0;
  /** Pools whose tape rides the poll loop (requested via reads). */
  private trackedPools = new Set<string>();
  /** Cooldown bookkeeping for lazy fetches. */
  private cooldowns = new Map<string, number>();
  /** Selector caches — stable refs between polls. */
  private tradesCache = new Map<string, Traded>();
  private volumeCache = new Map<string, Bucketed>();
  private trades24Cache = new Map<string, Bucketed>();
  /** Pool id per asset, cached against the gpus record reference. */
  private poolByAsset: { gpus: ProtocolMarketState["gpus"]; map: Readonly<Record<string, string>> } = {
    gpus: EMPTY_STATE.gpus,
    map: {},
  };

  constructor(
    private readonly client: ProtocolClient,
    private readonly now: () => number = Date.now,
    /** Browser-only gate for the lazy fetches; tests inject `() => true`. */
    private readonly canFetch: () => boolean = () => typeof window !== "undefined",
  ) {}

  get(): ProtocolMarketState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.ensureLoop();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopLoop();
    };
  }

  /** Reconciler path: re-poll now, bypassing every cooldown. */
  async refresh(): Promise<void> {
    this.cooldowns.clear();
    for (const poolId of this.trackedPools) void this.fetchSwaps(poolId);
    await this.poll(true);
  }

  // -- reads ------------------------------------------------------------------

  /** The pool backing one asset — canonical pool only, or null until the
   *  gpus row lands (or the asset has no canonical pool). */
  poolForAsset(asset: AssetId): PoolDto | null {
    const poolId = this.poolIdForAsset(asset);
    if (poolId === null) return null;
    return this.state.pools[poolId] ?? null;
  }

  /** The AMM tape for one asset, OLDEST-FIRST (the port contract). Stable
   *  reference between polls; empty ref when nothing landed yet. Typed
   *  mutable to satisfy the MarketDataPort contract — never mutated. */
  tradesFor(asset: AssetId): MarketTrade[] {
    this.ensureGpus();
    this.ensurePools();
    const pool = this.poolForAsset(asset);
    if (pool === null) return NO_TRADES;
    this.trackPool(pool.poolId);
    const swaps = this.state.swaps[pool.poolId];
    if (swaps === undefined || swaps.length === 0) return NO_TRADES;
    const hit = this.tradesCache.get(pool.poolId);
    if (hit !== undefined && hit.swaps === swaps) return hit.trades;
    const trades = swaps.map((s) => swapToMarketTrade(s, pool)).filter((t): t is MarketTrade => t !== null);
    this.tradesCache.set(pool.poolId, { swaps, trades });
    return trades;
  }

  /** 24h gUSD volume across the asset's canonical pool (hourly buckets). */
  volume24hOf(asset: AssetId): number | null {
    this.ensureGpus();
    this.ensurePools();
    const pool = this.poolForAsset(asset);
    if (pool === null) return null;
    this.ensureHourly(pool.poolId);
    const buckets = this.hourlyOf(pool.poolId).buckets;
    const hit = this.volumeCache.get(pool.poolId);
    if (hit !== undefined && hit.buckets === buckets) return hit.value;
    const value = volume24hGusd(buckets, Math.floor(this.now() / 1000));
    this.volumeCache.set(pool.poolId, { buckets, value });
    return value;
  }

  /** 24h swap count on the asset's canonical pool. */
  trades24hOf(asset: AssetId): number | null {
    this.ensureGpus();
    this.ensurePools();
    const pool = this.poolForAsset(asset);
    if (pool === null) return null;
    this.ensureHourly(pool.poolId);
    const buckets = this.hourlyOf(pool.poolId).buckets;
    const hit = this.trades24Cache.get(pool.poolId);
    if (hit !== undefined && hit.buckets === buckets) return hit.value;
    const value = trades24h(buckets, Math.floor(this.now() / 1000));
    this.trades24Cache.set(pool.poolId, { buckets, value });
    return value;
  }

  /** In-range gUSD-side depth of the asset's canonical pool — a depth
   *  figure for the stats strip, never a price. */
  liquidityUsdOf(asset: AssetId): number | null {
    this.ensureGpus();
    this.ensurePools();
    const pool = this.poolForAsset(asset);
    return pool === null ? null : inRangeGusdDepth(pool);
  }

  /** Oracle publication state for one gpu — lazy with cooldown, since only
   *  the transparency row asks for it. */
  ensureOracleState(gpuId: string): void {
    this.ensureOnce(`oracle:${gpuId}`, async () => {
      try {
        const body = await this.client.getOracleState(gpuId);
        this.state = {
          ...this.state,
          oracleState: { ...this.state.oracleState, [gpuId.toLowerCase()]: body.oracle },
        };
        this.commit();
      } catch {
        // keep prior state
      }
    });
  }

  /** Protocol aggregates + vault — lazy with cooldown; the poll also
   *  refreshes it once any subscriber keeps the loop alive. */
  ensureStats(): void {
    this.ensureOnce("stats", async () => {
      try {
        const body = await this.client.getStats();
        this.state = { ...this.state, stats: body };
        this.commit();
      } catch {
        // keep prior stats
      }
    });
  }

  // -- internals ----------------------------------------------------------------

  private hourlyOf(poolId: string): { fromSec: number; buckets: readonly PoolStatsBucketDto[] } {
    return this.state.hourly[poolId] ?? { fromSec: 0, buckets: EMPTY_BUCKETS };
  }

  private poolIdForAsset(asset: AssetId): string | null {
    if (this.poolByAsset.gpus !== this.state.gpus) {
      const map: Record<string, string> = {};
      for (const gpu of Object.values(this.state.gpus)) {
        if (gpu.canonicalPoolId === null) continue;
        const id = assetForGpuId(gpu.gpuId as `0x${string}`);
        if (id !== null) map[id] = gpu.canonicalPoolId;
      }
      this.poolByAsset = { gpus: this.state.gpus, map };
    }
    return this.poolByAsset.map[asset] ?? null;
  }

  /** Resolve the gpus rows on first asset-keyed read (the poll also carries
   *  them; this covers the read-before-first-poll path). */
  private ensureGpus(): void {
    if (Object.keys(this.state.gpus).length > 0) return;
    this.ensureOnce("gpus", () => this.fetchGpus());
  }

  /** Resolve the pool rows on first asset-keyed read — poolForAsset needs
   *  them, and lazy reads without a subscriber never hit the poll loop. */
  private ensurePools(): void {
    if (Object.keys(this.state.pools).length > 0) return;
    this.ensureOnce("pools", () => this.fetchPools());
  }

  private trackPool(poolId: string): void {
    if (!this.canFetch()) return;
    if (this.trackedPools.has(poolId)) return;
    this.trackedPools.add(poolId);
    void this.fetchSwaps(poolId);
  }

  private ensureHourly(poolId: string): void {
    this.ensureOnce(`hourly:${poolId}`, () => this.fetchHourly(poolId));
  }

  /** Run `fetch` unless the key is cooling down (30s retry cadence). */
  private ensureOnce(key: string, fetch: () => Promise<void>): void {
    if (!this.canFetch()) return;
    if (this.now() < (this.cooldowns.get(key) ?? 0)) return;
    this.cooldowns.set(key, this.now() + COOLDOWN_MS);
    void fetch();
  }

  private ensureLoop(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void this.poll();
      }
    }, POLL_MS);
    void this.poll();
  }

  private stopLoop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll pass. Every read is independent (allSettled): a failure in
   *  one slice keeps that slice's prior value — null doctrine. */
  private async poll(force = false): Promise<void> {
    if (!force && this.now() - this.lastPollAt < POLL_MS / 2) return;
    this.lastPollAt = this.now();
    const [pools, gpus, stats] = await Promise.allSettled([
      this.client.listPools(),
      this.client.listGpus(),
      this.client.getStats(),
    ]);
    let poolsIn: Record<string, PoolDto> | null = null;
    let gpusIn: Record<string, GpuAssetDto> | null = null;
    let statsIn: StatsBody | null = null;
    if (pools.status === "fulfilled") {
      poolsIn = { ...this.state.pools };
      for (const pool of pools.value.pools) poolsIn[pool.poolId.toLowerCase()] = pool;
    }
    if (gpus.status === "fulfilled") {
      gpusIn = { ...this.state.gpus };
      for (const gpu of gpus.value.gpus) gpusIn[gpu.gpuId.toLowerCase()] = gpu;
    }
    if (stats.status === "fulfilled") {
      statsIn = stats.value;
    }
    if (poolsIn !== null || gpusIn !== null || statsIn !== null) {
      this.state = {
        ...this.state,
        ...(poolsIn !== null ? { pools: poolsIn } : {}),
        ...(gpusIn !== null ? { gpus: gpusIn } : {}),
        ...(statsIn !== null ? { stats: statsIn } : {}),
      };
      this.commit();
    }
    // Tapes ride after the pool rows: tracked pools are known by now.
    await Promise.allSettled([...this.trackedPools].map((poolId) => this.fetchSwaps(poolId)));
  }

  private async fetchSwaps(poolId: string): Promise<void> {
    try {
      const body = await this.client.getPoolSwaps(poolId, { limit: SWAP_CAP });
      // The wire is newest-first; the port serves oldest-first.
      const swaps = Object.freeze(body.swaps.slice().reverse());
      this.state = { ...this.state, swaps: { ...this.state.swaps, [poolId]: swaps } };
      this.commit();
    } catch {
      // keep prior tape
    }
  }

  private async fetchGpus(): Promise<void> {
    try {
      const body = await this.client.listGpus();
      const gpus = { ...this.state.gpus };
      for (const gpu of body.gpus) gpus[gpu.gpuId.toLowerCase()] = gpu;
      this.state = { ...this.state, gpus };
      this.commit();
    } catch {
      // keep prior rows
    }
  }

  private async fetchPools(): Promise<void> {
    try {
      const body = await this.client.listPools();
      const pools = { ...this.state.pools };
      for (const pool of body.pools) pools[pool.poolId.toLowerCase()] = pool;
      this.state = { ...this.state, pools };
      this.commit();
    } catch {
      // keep prior rows
    }
  }

  private async fetchHourly(poolId: string): Promise<void> {
    try {
      const fromSec = Math.floor(this.now() / 1000) - DAY_SEC;
      const body = await this.client.getPoolStats(poolId, { fromSec });
      this.state = {
        ...this.state,
        hourly: { ...this.state.hourly, [poolId]: { fromSec, buckets: Object.freeze(body.buckets) } },
      };
      this.commit();
    } catch {
      // keep prior buckets
    }
  }

  private commit(): void {
    this.state = { ...this.state, version: this.state.version + 1 };
    for (const listener of this.listeners) listener();
  }
}

/** Typed mutable to satisfy the MarketDataPort contract; treated as frozen. */
const NO_TRADES: MarketTrade[] = [];
const EMPTY_BUCKETS: readonly PoolStatsBucketDto[] = Object.freeze([]);

// --- singleton seam -------------------------------------------------------------

let singleton: ProtocolMarketStore | null = null;

/** The shared store, or null when the protocol market gate is closed. */
export function getProtocolMarketStore(): ProtocolMarketStore | null {
  if (singleton !== null) return singleton;
  const client = getProtocolClient();
  if (client === null) return null;
  singleton = new ProtocolMarketStore(client);
  return singleton;
}

/** Test seam: drop the singleton so a suite starts clean. */
export function disposeProtocolMarketStore(): void {
  singleton = null;
}

/** The gpuId (bytes32, lowercase) behind a product asset — the store's
 *  oracle-state key. */
export function oracleStateKeyFor(asset: AssetId): string {
  return gpuIdForAsset(asset).toLowerCase();
}
