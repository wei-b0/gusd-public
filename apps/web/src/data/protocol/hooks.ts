"use client";

/**
 * React seams over the protocol market store — the one place UI reads the
 * indexed market slices directly, mirroring use-oracle-feed.ts. Inert
 * without the indexer (no store ⇒ no subscription, no fetch, the mock-safe
 * server snapshot) exactly like the feed hooks' mock gating.
 *
 * The read closures carry the lazily-ensured fetches (tapes, hourly
 * buckets, oracle state) — the same idempotent read-path idiom the
 * market-data overlay uses: ensures are cooldown-gated inside the store, so
 * re-renders never stack requests.
 */

import { useSyncExternalStore } from "react";
import type { AssetId } from "@/domain/types";
import { isOracleBacked } from "@/data/oracle/panel-map";
import { getProtocolMarketStore, oracleStateKeyFor, type ProtocolMarketStore } from "./market-store";
import {
  getIndexedActivityStore,
  useIndexedActivity,
  type IndexedActivityState,
} from "./activity-store";
import type { OracleStateDto, PoolDto, StatsBody } from "./dto";

/** Read one slice of the protocol store as an externally-stored value. No
 *  store (indexer unset, or mock market mode) reads `server`. */
function useProtocolSlice<T>(read: (store: ProtocolMarketStore) => T, server: T): T {
  const store = getProtocolMarketStore();
  return useSyncExternalStore(
    (cb) => (store !== null ? store.subscribe(cb) : () => {}),
    () => (store !== null ? read(store) : server),
    () => server,
  );
}

/** Every indexed pool row, keyed by lowercase poolId. */
export function useProtocolPools(): Readonly<Record<string, PoolDto>> {
  return useProtocolSlice((store) => store.get().pools, EMPTY_POOLS);
}
const EMPTY_POOLS: Readonly<Record<string, PoolDto>> = {};

/** Protocol aggregates + vault (stats endpoint), ensured on first read. */
export function useProtocolStats(): StatsBody | null {
  return useProtocolSlice((store) => {
    store.ensureStats();
    return store.get().stats;
  }, null);
}

/** The indexed oracle publication state behind one asset — transparency
 *  only. Consumers render health/comparison fields (publication value at
 *  PRICE_SCALE, staleness/age/block, benchmark-vs-onchain gap on the Health
 *  tab); it must never render as a market or display price — the four
 *  price notions stay apart. */
export function useOraclePublication(asset: AssetId): OracleStateDto | null {
  return useProtocolSlice(
    (store) => {
      if (!isOracleBacked(asset)) return null;
      const key = oracleStateKeyFor(asset);
      store.ensureOracleState(key);
      return store.get().oracleState[key] ?? null;
    },
    null,
  );
}

/** The connected wallet's indexed activity — routed executions, raw
 *  protocol events, and the vault position. The session binds the address
 *  (web3-services); without a session or the indexer this is the empty
 *  state, never an error. `loadEarlier` pages both streams (no-ops at the
 *  hard cap or when a stream is exhausted). */
export interface WalletActivityView extends IndexedActivityState {
  loadEarlier(): void;
}

export function useWalletActivity(): WalletActivityView {
  const store = getIndexedActivityStore();
  const state = useIndexedActivity(store);
  return {
    ...state,
    loadEarlier: () => {
      void store.loadMoreExecutions();
      void store.loadMoreEvents();
    },
  };
}
