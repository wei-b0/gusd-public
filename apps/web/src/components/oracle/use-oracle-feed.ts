"use client";

/**
 * Feed hooks for the Oracle section — the one place UI reads the wire store
 * directly. Every hook keeps the mock data source out of the feed: in mock
 * mode both the subscription and the read are gated off (no connection, no
 * requests, mock-safe server snapshots), exactly like the composite market
 * data port's oracle mode.
 *
 * The read closures carry the lazily-ensured fetches (candles, panel
 * receipts, provider registry) — the same idempotent read-path pattern the
 * market-data overlay uses: every ensure is pending-guarded and cooled down
 * inside the store, so re-renders never stack requests.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RANGE_INTERVAL_SEC, RANGE_WINDOW_MS, type AssetId, type ChartRange, type IndexPoint } from "@/domain/types";
import { DATA_SOURCE } from "@/data/oracle/config";
import type { CandidateDto, HealthResponse, PanelProvidersDto, ProviderDto } from "@/data/oracle/dto";
import { getOracleFeed, type CandleSet, type Connection, type OracleFeedState } from "@/data/oracle/feed";
import { bucketsToPoints } from "@/data/oracle/map";
import { ORACLE_PANELS } from "@/data/oracle/panel-map";

/** Read one slice of the feed as an externally-stored value. `read` runs in
 *  oracle mode only; mock/SSR read `server`, the mock-safe constant. */
function useFeedSlice<T>(read: (state: OracleFeedState) => T, server: T): T {
  const feed = getOracleFeed();
  return useSyncExternalStore(
    (cb) => (DATA_SOURCE === "oracle" ? feed.subscribe(cb) : () => {}),
    () => (DATA_SOURCE === "oracle" ? read(feed.getState()) : server),
    () => server,
  );
}

/** The feed's latest candidate for one gpu — null before anything publishes. */
export function useWireCandidate(gpuId: string): CandidateDto | null {
  return useFeedSlice((state) => state.latest[gpuId] ?? null, null);
}

/**
 * Ticking `Date.now()`, null until mount — the house hydration pattern for
 * age cells: the server render prints absolute stamps, the post-mount clock
 * switches them to ages. Same contract as the status line's clock.
 */
export function useNowTick(stepMs = 5_000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(id);
  }, [stepMs]);
  return now;
}

/** Latest candidates across every gpu the oracle reports, keyed by gpuId. */
export function useWireLatest(): Record<string, CandidateDto> {
  return useFeedSlice((state) => state.latest, EMPTY_LATEST);
}
const EMPTY_LATEST: Record<string, CandidateDto> = {};

/** The feed's transport state — oracle mode only; mock reads "idle". */
export function useWireConnection(): Connection {
  return useFeedSlice((state) => state.connection, "idle");
}

/**
 * The contributor panel behind one gpu's latest candidate.
 *   undefined — not fetched yet (pending, mock mode, or nothing in flight)
 *   null      — the oracle answered 404: no candidate was ever computed
 *   panel     — the receipt, kept in lockstep with the latest candidate by
 *               the store (one refetch per publication).
 */
export function useWirePanelProviders(gpuId: string): PanelProvidersDto | null | undefined {
  const feed = getOracleFeed();
  return useFeedSlice((state) => {
    if (gpuId) feed.ensurePanelProviders(gpuId);
    return state.panelProviders[gpuId];
  }, undefined);
}

/** The provider registry (GET /v1/providers) — ensured, so a bootstrap
 *  rejection retries on the cooldown instead of leaving the registry empty. */
export function useWireProviders(): ProviderDto[] {
  const feed = getOracleFeed();
  return useFeedSlice((state) => {
    feed.ensureProviders();
    return state.providers;
  }, EMPTY_PROVIDERS);
}
const EMPTY_PROVIDERS: ProviderDto[] = [];

/** The feed's health document, refreshed by the store's own minute tick. */
export function useWireHealth(): HealthResponse | null {
  return useFeedSlice((state) => state.health, null);
}

/**
 * The canonical benchmark series for one asset at a chart range, from the
 * feed's server-bucketed candles — the fix for the /oracle history chart
 * (the market snapshot's `index: []` is deliberate: the candles ARE the
 * canonical Index, and this hook is the second rendering the surface reads).
 *
 * Object.is stability is load-bearing under useSyncExternalStore: the points
 * array is cached against the CandleSet's object reference (the store
 * replaces it only when buckets actually change) plus a minute-floored
 * window key, so a 60s health commit costs zero re-renders and the trailing
 * edge still advances on every fold. Null until the window holds a series.
 */
export function useOracleSeries(asset: AssetId, range: ChartRange): IndexPoint[] | null {
  const feed = getOracleFeed();
  const cache = useRef<{ key: string; set: CandleSet | null; points: IndexPoint[] | null }>({
    key: "",
    set: null,
    points: null,
  });
  return useSyncExternalStore(
    (cb) => (DATA_SOURCE === "oracle" ? feed.subscribe(cb) : () => {}),
    () => {
      if (DATA_SOURCE !== "oracle") return null;
      const gpuId = ORACLE_PANELS[asset]?.gpuId;
      if (!gpuId) return null;
      const intervalSec = RANGE_INTERVAL_SEC[range];
      // The window start is floored to the minute so the cache key (and with
      // it the returned array reference) stays stable within a render pass.
      const fromMs = Math.floor(Date.now() / 60_000) * 60_000 - RANGE_WINDOW_MS[range];
      feed.ensureCandles(gpuId, intervalSec, fromMs);
      const set = feed.getState().candles[gpuId]?.[String(intervalSec)] ?? null;
      const key = `${gpuId}:${intervalSec}:${fromMs}`;
      const hit = cache.current;
      if (hit.key === key && hit.set === set) return hit.points;
      const points = set ? bucketsToPoints(set.buckets).filter((p) => p.t >= fromMs) : null;
      cache.current = { key, set, points: points !== null && points.length >= 2 ? points : null };
      return cache.current.points;
    },
    () => null,
  );
}
