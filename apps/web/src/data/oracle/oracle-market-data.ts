/**
 * The composite MarketDataPort — API-only display in oracle mode.
 *
 * Every displayed GPU price and market figure comes exclusively from the
 * oracle API (REST + SSE). There is no second price: the benchmark the API
 * publishes is the price these surfaces show. Market-layer facts — venue
 * price, traded volume, depth, the trade tape — have no backend yet, so they
 * are null/empty here and the UI says so; they are never simulated. What the
 * API does publish is served as series: OHLC candles for every chart range
 * from the server-bucketed canonical benchmark series (the database's
 * index_candidates — not trades, not onchain publications), window stats from
 * that series gated on real coverage, sparklines from its hourly closes, and
 * freshness/quality from the candidates themselves.
 *
 * Classes with no settlement panel in the catalog pass through as pure mock —
 * their indexStatus is absent, which the UI reads as simulated. (The catalog
 * currently gives every listed class a panel.)
 *
 * Snapshot identity: useSyncExternalStore requires Object.is-stable returns,
 * but the inner mock port builds fresh objects on every call. The composite
 * therefore caches per read path and invalidates on any notify from either
 * layer.
 */

import type { MarketDataPort } from "@/domain/ports";
import type {
  AssetId,
  ChartRange,
  Market,
  MarketStats,
  MarketSnapshot,
  MarketTrade,
  ProviderObservation,
} from "@/domain/types";
import {
  CHART_RANGES,
  RANGE_INTERVAL_SEC,
  RANGE_WINDOW_MS,
  parseAssetId,
} from "@/domain/types";
import type { CandidateDto } from "./dto";
import type { OracleFeedStore } from "./feed";
import {
  CHANGE24_TOLERANCE_MS,
  bucketsToCandles,
  bucketsToPoints,
  deriveChange24h,
  deriveWindowStats,
  deriveWindowStatsFromCandles,
  historyToIndexPoints,
  indexPointsToCandles,
  lastKnownIndexPrice,
  mapIndexStatus,
  mapProviders,
  mapQuality,
  sparklineFromBuckets,
  sparklineFromPoints,
} from "./map";
import { ORACLE_PANELS, isOracleBacked, type OracleAssetId } from "./panel-map";

const DAY_MS = 86_400_000;
const THIRTY_DAY_MS = 30 * DAY_MS;
/** First-paint bridge grain for the 1m view: one-minute bars from the
 *  real prints already in hand. */
const CANDLE_BUCKET_MS = 60_000;
/** Sparkline grain: the last 48 hourly closes of the benchmark series —
 *  the register's trailing two days. */
const SPARKLINE_INTERVAL_SEC = 3_600;
const SPARKLINE_WINDOW_MS = 48 * 3_600_000;

/**
 * The series plan per chart interval: the oracle buckets the canonical
 * benchmark series (the database's index_candidates — not trades, not
 * onchain publications) at the grain the selector names, over the window
 * the domain plan assigns it — sized for 240–365 visible bars, wide enough
 * to read structure, tight enough that every bar keeps several pixels on a
 * desktop pane, and always inside the candles endpoint's per-request bucket
 * cap (2000). Before trading exists these candles ARE the market's price
 * history: every interval aggregates the computed benchmarks that landed
 * within it.
 */
const RANGE_SERIES = Object.fromEntries(
  CHART_RANGES.map((r) => [
    r,
    { intervalSec: RANGE_INTERVAL_SEC[r], windowMs: RANGE_WINDOW_MS[r] },
  ]),
) as Record<ChartRange, { intervalSec: number; windowMs: number }>;
/** The one empty tape — a stable reference, not a fresh array per read. */
const NO_TRADES: MarketTrade[] = [];
const NO_STATS: MarketStats = {
  open24h: null,
  high24h: null,
  low24h: null,
  high30d: null,
  low30d: null,
  trades24h: null,
  avgTradeSize: null,
};

export class OracleMarketData implements MarketDataPort {
  private listeners = new Set<(markets: Market[]) => void>();
  private innerUnsubscribe: (() => void) | null = null;
  private feedUnsubscribe: (() => void) | null = null;
  private dirty = true;
  private cachedMarkets: Market[] | null = null;
  private cachedSnapshots = new Map<string, MarketSnapshot | null>();

  constructor(
    /** The base layer (the mock engine) — owned by reference, not wrapped.
     *  Supplies static asset shells and the tick clock for the trading/earn
     *  prototypes; its market numbers never surface in oracle mode. */
    private inner: MarketDataPort,
    private feed: OracleFeedStore,
  ) {}

  subscribe(listener: (markets: Market[]) => void): () => void {
    this.listeners.add(listener);
    if (!this.innerUnsubscribe) {
      // One inner + one feed subscription for the whole tree: the mock tick
      // loop (and the earn accrual riding it) stays alive exactly once, and
      // the feed opens exactly one connection.
      this.innerUnsubscribe = this.inner.subscribe(() => this.notify());
      this.feedUnsubscribe = this.feed.subscribe(() => this.notify());
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.innerUnsubscribe) {
        this.innerUnsubscribe();
        this.innerUnsubscribe = null;
        this.feedUnsubscribe?.();
        this.feedUnsubscribe = null;
      }
    };
  }

  listMarkets(): Market[] {
    if (!this.dirty && this.cachedMarkets) return this.cachedMarkets;
    this.markClean();
    const now = Date.now();
    this.cachedMarkets = this.inner.listMarkets().map((m) => this.overlayMarket(m, now));
    return this.cachedMarkets;
  }

  getSnapshot(asset: AssetId, range: ChartRange = "5m"): MarketSnapshot | null {
    if (!parseAssetId(asset)) return null;
    const key = `${asset}:${range}`;
    if (!this.dirty && this.cachedSnapshots.has(key)) {
      return this.cachedSnapshots.get(key) ?? null;
    }
    this.markClean();
    const base = this.inner.getSnapshot(asset, range);
    if (!base) return null;
    const next = isOracleBacked(asset) ? this.overlaySnapshot(base, asset, range) : base;
    this.cachedSnapshots.set(key, next);
    return next;
  }

  getRecentTrades(asset: AssetId) {
    if (!isOracleBacked(asset)) return this.inner.getRecentTrades(asset);
    // No market tape exists — no trades, no invented prints.
    return NO_TRADES;
  }

  /** The API's current Index price for one asset — the one real price, and
   *  the price prototype execution quotes against. Null when the feed holds
   *  no asserted price (never a simulated stand-in). */
  indexPriceOf(asset: AssetId): number | null {
    if (!isOracleBacked(asset)) return null;
    const candidates = this.candidatesFor(asset);
    return candidates.length === 0 ? null : lastKnownIndexPrice(candidates);
  }

  // -- overlay ----------------------------------------------------------------

  /** All candidates the feed holds for one panel asset, oldest-first. */
  private candidatesFor(asset: OracleAssetId): CandidateDto[] {
    const { gpuId } = ORACLE_PANELS[asset];
    const state = this.feed.getState();
    const history = state.history[gpuId];
    if (history && history.length > 0) return history;
    const latest = state.latest[gpuId];
    return latest ? [latest] : [];
  }

  /** Market-row overlay: the row is the API's. The benchmark is the only
   *  price (the venue leg is null until a market-data feed exists); the
   *  sparkline is the benchmark series' own last 48 hourly closes, loaded
   *  lazily from the server-bucketed series (until it lands, the candidate
   *  prints' own closes stand in). With no candidates at all the Index
   *  fields go null with `unavailable`; with candidates but no asserted
   *  price (withheld from birth) the status carries the truth and the figure
   *  prints "—". Basis has no meaning without a market price and stays null
   *  in oracle mode. */
  private overlayMarket(m: Market, now: number): Market {
    if (!isOracleBacked(m.asset.id)) return m;
    const gpuId = ORACLE_PANELS[m.asset.id].gpuId;
    const candidates = this.candidatesFor(m.asset.id);
    if (candidates.length === 0) {
      return {
        ...m,
        marketPrice: null,
        change24hPct: null,
        change7dPct: null,
        indexPrice: null,
        indexChange24hPct: null,
        basisPct: null,
        indexStatus: "unavailable",
        volume24hUsd: null,
        liquidityUsd: null,
        sparkline: [],
      };
    }
    this.feed.ensureCandles(gpuId, SPARKLINE_INTERVAL_SEC, now - SPARKLINE_WINDOW_MS);
    const latest = candidates[candidates.length - 1]!;
    const points = historyToIndexPoints(candidates);
    const hourly = this.feed.getState().candles[gpuId]?.[String(SPARKLINE_INTERVAL_SEC)];
    // The 24h move anchors on the hourly series (the feed's 500-print history
    // rarely reaches a day back); the candidate prints cover it only until
    // the series lands.
    const hourlyPoints = hourly && hourly.buckets.length > 1 ? bucketsToPoints(hourly.buckets) : null;
    return {
      ...m,
      marketPrice: null,
      change24hPct: null,
      change7dPct: null,
      indexPrice: lastKnownIndexPrice(candidates),
      indexChange24hPct: deriveChange24h(hourlyPoints ?? points, now),
      basisPct: null,
      indexStatus: mapIndexStatus(latest, now),
      volume24hUsd: null,
      liquidityUsd: null,
      sparkline:
        hourly && hourly.buckets.length > 1
          ? sparklineFromBuckets(hourly.buckets)
          : sparklineFromPoints(points),
    };
  }

  /** Snapshot overlay: candles, series, provider panel, and stats all derive
   *  from the API's own data. Candles for EVERY range come from the
   *  server-bucketed canonical benchmark series (client-side bucketing only
   *  bridges the 1D first paint, from the candidate prints already in hand);
   *  the Index line is the print series on 1D and the series' closes on the
   *  longer ranges; window stats gate themselves on real coverage. The tape
   *  is empty. With no candidates there is no publication to describe —
   *  quality is null, not an invented empty report. */
  private overlaySnapshot(
    base: MarketSnapshot,
    asset: OracleAssetId,
    range: ChartRange,
  ): MarketSnapshot {
    const now = Date.now();
    const gpuId = ORACLE_PANELS[asset].gpuId;
    const candidates = this.candidatesFor(asset);
    const market = this.overlayMarket(base.market, now);
    if (candidates.length === 0) {
      return {
        ...base,
        market,
        candles: [],
        index: [],
        providers: [],
        recentTrades: NO_TRADES,
        stats: NO_STATS,
        quality: null,
      };
    }
    // The range's own series, plus the fixed 24h/30d stat windows the
    // statistics panel shows on every range.
    const series = RANGE_SERIES[range];
    this.feed.ensureCandles(gpuId, series.intervalSec, now - series.windowMs);
    if (series.intervalSec !== 60) this.feed.ensureCandles(gpuId, 60, now - DAY_MS);
    if (series.intervalSec !== 3600) {
      this.feed.ensureCandles(gpuId, 3600, now - THIRTY_DAY_MS);
    }
    const state = this.feed.getState();
    const seriesOf = (intervalSec: number) => state.candles[gpuId]?.[String(intervalSec)];
    const candlesOf = (intervalSec: number) => {
      const set = seriesOf(intervalSec);
      return set ? bucketsToCandles(set.buckets) : [];
    };
    const points = historyToIndexPoints(candidates);

    const latest = candidates[candidates.length - 1]!;
    const dayCandles = candlesOf(60);
    const monthCandles = candlesOf(3600);
    const day =
      dayCandles.length > 0
        ? deriveWindowStatsFromCandles(dayCandles, now, DAY_MS, CHANGE24_TOLERANCE_MS)
        : deriveWindowStats(points, now, DAY_MS, CHANGE24_TOLERANCE_MS);
    // 30d exists only once the series actually reaches back 30d; until then
    // it self-gates to null rather than pose.
    const month =
      monthCandles.length > 0
        ? deriveWindowStatsFromCandles(monthCandles, now, THIRTY_DAY_MS, 0)
        : deriveWindowStats(points, now, THIRTY_DAY_MS, 0);

    // The 60s series doubles as the 24h stats window, and the feed's cache
    // is keyed by interval alone — it can hold more than the selected
    // range's window. Every render-boundary series is cut to the window, or
    // the 1m pane drags yesterday's buckets in and stretches the scale.
    // Same guard for the print series (it spans whatever the history
    // endpoint holds).
    const windowStart = now - series.windowMs;
    const rangeCandles = candlesOf(series.intervalSec).filter((c) => c.t >= windowStart);
    const windowedPoints = points.filter((p) => p.t >= windowStart);
    const panel = state.panelProviders[gpuId];
    const providers: ProviderObservation[] = panel ? mapProviders(panel, now) : [];
    return {
      ...base,
      market,
      candles:
        series.intervalSec === 60 && rangeCandles.length === 0
          ? // First paint bridge: bucket the prints already in hand while the
            // server's one-minute series is in flight.
            indexPointsToCandles(windowedPoints, CANDLE_BUCKET_MS)
          : rangeCandles,
      index:
        series.intervalSec === 60
          ? windowedPoints
          : (() => {
              const set = seriesOf(series.intervalSec);
              return set
                ? bucketsToPoints(set.buckets).filter((p) => p.t >= windowStart)
                : [];
            })(),
      providers,
      recentTrades: NO_TRADES,
      stats: {
        open24h: day.open,
        high24h: day.high,
        low24h: day.low,
        high30d: month.high,
        low30d: month.low,
        trades24h: null,
        avgTradeSize: null,
      },
      quality: mapQuality(latest),
    };
  }

  private notify(): void {
    this.dirty = true;
    const markets = this.listMarkets();
    for (const listener of this.listeners) listener(markets);
  }

  /** Drop per-key snapshot caches on the first read after a change. */
  private markClean(): void {
    if (this.dirty) {
      this.dirty = false;
      this.cachedSnapshots.clear();
    }
  }
}
