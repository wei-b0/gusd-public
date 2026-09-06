/**
 * TradingView Advanced Charts datafeed over the oracle API — the chart's
 * only data path. The backend stays the source of truth: history comes from
 * GET /v1/prices/:gpu/candles (the server-bucketed canonical benchmark
 * series), realtime comes from the shared feed store (SSE candidates folded
 * into the trailing edge by `foldCandidateIntoBuckets`), and the datafeed
 * never derives OHLC client-side.
 *
 * Wiring doctrine:
 *   - getBars is REST-only. Chart pagination (scrolling back) must never
 *     read the store, whose windows are bounded by the UI's series plan.
 *     Every response is also ingested into the store so the desk's stats and
 *     the chart share one series state without duplicate GETs.
 *   - subscribeBars rides the store's one SSE connection. On each commit it
 *     emits every grid bucket newer than the last emitted bar — including
 *     the carried flat buckets the fold splices across silent intervals —
 *     so the chart's grid stays regular between ticks.
 *   - A store-side resync can re-bucket history (REST is the truth). The
 *     datafeed detects the reshape (first bucket moved, array shrank) and
 *     fires `onSeriesReset` instead of emitting a flood of stale ticks; the
 *     component maps that to a debounced `resetData()` so the chart reloads
 *     from the server.
 */

import type { MarketDataPort } from "@/domain/ports";
import type { AssetId, ChartRange } from "@/domain/types";
import { RANGE_INTERVAL_SEC, RANGE_WINDOW_MS } from "@/domain/types";
import type { TvBar, TvDatafeedChartApi, TvSymbolInfo } from "@/types/tradingview";
import type { CandleDto } from "./dto";
import type { OracleClient } from "./client";
import type { OracleFeedStore } from "./feed";

/** The oracle /candles endpoint's per-request bucket cap (mirrored wire
 *  contract, like the DTOs). The datafeed clamps history windows to it so a
 *  wide scroll-back can never trip the server's 400. */
const CANDLE_MAX_BUCKETS = 2000;

// ---------------------------------------------------------------------------
// Resolution maps — ChartRange (domain) ⇄ TradingView resolution string
// ---------------------------------------------------------------------------

export const RANGE_TO_TV: Record<ChartRange, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "6h": "360",
  "12h": "720",
  "1d": "1D",
  "1w": "1W",
};

/** The chart's interval selector names a domain range; the widget speaks TV
 *  resolution strings. */
export function tvResolution(range: ChartRange): string {
  return RANGE_TO_TV[range];
}

/** TV resolution → the oracle interval it maps to. Null when unsupported —
 *  the widget's own interval switcher is disabled, but a bad string must
 *  never silently fall through to a wrong grain. */
export function intervalSecFromTv(resolution: string): number | null {
  for (const [range, tv] of Object.entries(RANGE_TO_TV)) {
    if (tv === resolution) return RANGE_INTERVAL_SEC[range as ChartRange];
  }
  return null;
}

/** Oracle interval → the domain range it names (for window plans). */
export function chartRangeForInterval(intervalSec: number): ChartRange | null {
  const entry = (Object.entries(RANGE_INTERVAL_SEC) as [ChartRange, number][]).find(
    ([, sec]) => sec === intervalSec,
  );
  return entry ? entry[0] : null;
}

/** Wire bucket → TV bar. Bar `time` is the interval open **in epoch
 *  milliseconds** — the library consumes bar times as ms (its own reference
 *  datafeeds pass Binance's ms kline open times straight through and compare
 *  them against `periodParams.to * 1000`), while history-request
 *  periodParams are seconds. OHLC unchanged: the chart renders what the
 *  server computed — carried flags and sample counts stay behind as audit,
 *  not chart data. */
export function candleToTvBar(bucket: CandleDto): TvBar {
  return {
    time: bucket.t,
    open: bucket.open,
    high: bucket.high,
    low: bucket.low,
    close: bucket.close,
  };
}

/** Clamp a requested history window to the server's per-request bucket cap. */
export function clampHistoryWindow(fromMs: number, toMs: number, intervalSec: number): {
  fromMs: number;
  toMs: number;
} {
  const stepMs = intervalSec * 1000;
  return { fromMs: Math.max(fromMs, toMs - CANDLE_MAX_BUCKETS * stepMs), toMs };
}

// ---------------------------------------------------------------------------
// The datafeed
// ---------------------------------------------------------------------------

/** Datafeed configuration delivered from onReady. The library stores it as
 *  its global configurationData — this build reads
 *  `configurationData.is_tradingview_data` unguarded, so a bare callback()
 *  crashes resolution handling and the chart never boots (blank pane).
 *  Search/group request are off: the symbol is fixed at construction and
 *  resolveSymbol serves it. */
const DATAFEED_CONFIG = {
  supported_resolutions: Object.values(RANGE_TO_TV),
  supports_search: false,
  supports_group_request: false,
  supports_marks: false,
  supports_timescale_marks: false,
  supports_time: true,
};

export interface TvDatafeedOptions {
  asset: AssetId;
  gpuId: string;
  /** Fired when the loaded series was re-bucketed server-side (a resync
   *  re-bucketed history, not just extended the tail) for an interval. */
  onSeriesReset?: (intervalSec: number) => void;
}

/** What the component hands in depends on the data source: oracle mode gets
 *  the shared feed store + REST client, mock mode gets the market-data port
 *  (the simulated universe must stay network-free). */
export type TvDatafeedDeps =
  | { mode: "oracle"; feed: OracleFeedStore; client: OracleClient }
  | { mode: "mock"; port: MarketDataPort };

/** The datafeed plus its explicit teardown. `dispose` is not part of the TV
 *  contract — the widget only promises unsubscribeBars on resolution changes,
 *  so the component calls dispose itself before `widget.remove()`. */
export interface TvDatafeedHandle {
  datafeed: TvDatafeedChartApi;
  dispose(): void;
}

export function createTvDatafeed(
  deps: TvDatafeedDeps,
  options: TvDatafeedOptions,
): TvDatafeedHandle {
  return deps.mode === "oracle"
    ? createOracleDatafeed(deps.feed, deps.client, options)
    : createMockDatafeed(deps.port, options);
}

function symbolInfoFor(options: TvDatafeedOptions): TvSymbolInfo {
  const resolutions = Object.values(RANGE_TO_TV);
  return {
    ticker: options.gpuId,
    name: options.asset,
    description: `gUSD ${options.asset} GPU-hour Index`,
    type: "index",
    session: "24x7",
    timezone: "Etc/UTC",
    exchange: "GUSD",
    listed_exchange: "GUSD",
    format: "price",
    // 4dp — the benchmark moves in fractions of a cent; 2dp would suppress
    // whole axis labels (the same reason IndexChart pins 4dp).
    pricescale: 10_000,
    minmov: 1,
    has_intraday: true,
    has_daily: true,
    supported_resolutions: resolutions,
    // No volume fields at all: the benchmark history is OHLC-only, and a
    // volume surface without data behind it would render an error badge.
    data_status: "streaming",
  };
}

// -- oracle mode -------------------------------------------------------------

/** Fingerprint of the last bar handed to the chart for one interval — both
 *  the bar's open time and its OHLC, so a fold that revises the trailing
 *  bucket (close/high/low, or a carried→real promotion rewriting open)
 *  re-emits even though `t` is unchanged. */
interface BarFingerprint {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface IntervalWatch {
  baseline: BarFingerprint | null;
  /** Shape of the set as last seen — a changed first bucket or a shrunken
   *  array means the server re-bucketed history (resync), not a tail tick. */
  seenFirstT: number | null;
  seenLength: number;
}

function fingerprintOf(bucket: CandleDto): BarFingerprint {
  return { t: bucket.t, open: bucket.open, high: bucket.high, low: bucket.low, close: bucket.close };
}

function createOracleDatafeed(
  feed: OracleFeedStore,
  client: OracleClient,
  options: TvDatafeedOptions,
): TvDatafeedHandle {
  const symbol = symbolInfoFor(options);
  const { gpuId } = options;

  // One store subscription per datafeed, fanning out to every registered
  // onTick — TV may briefly hold two resolution subscriptions across a
  // switch, and StrictMode mounts twice.
  const watches = new Map<number, IntervalWatch>(); // intervalSec → watch
  const sinks = new Map<string, { intervalSec: number; onTick: (bar: TvBar) => void }>();
  let storeUnsubscribe: (() => void) | null = null;

  function ensureStoreSubscription(): void {
    if (storeUnsubscribe) return;
    storeUnsubscribe = feed.subscribe(() => fanOut());
  }

  function dispose(): void {
    sinks.clear();
    watches.clear();
    if (storeUnsubscribe) {
      storeUnsubscribe();
      storeUnsubscribe = null;
    }
  }

  function fanOut(): void {
    const state = feed.getState();
    for (const { intervalSec, onTick } of sinks.values()) {
      const set = state.candles[gpuId]?.[String(intervalSec)];
      if (!set) continue;
      const watch = watches.get(intervalSec);
      if (!watch) continue;

      // Structural reshape → reset, not ticks: the server's refetch
      // re-bucketed history, and emitting the tail alone would leave older
      // in-chart bars stale.
      const firstT = set.buckets.length > 0 ? set.buckets[0]!.t : null;
      if (
        watch.baseline !== null &&
        ((firstT !== null && firstT !== watch.seenFirstT) ||
          set.buckets.length < watch.seenLength)
      ) {
        watch.seenFirstT = firstT;
        watch.seenLength = set.buckets.length;
        watch.baseline = set.buckets.length > 0 ? fingerprintOf(set.buckets[set.buckets.length - 1]!) : null;
        options.onSeriesReset?.(intervalSec);
        continue;
      }
      watch.seenFirstT = firstT;
      watch.seenLength = set.buckets.length;

      if (set.buckets.length === 0) continue;
      const tail = set.buckets[set.buckets.length - 1]!;
      if (!watch.baseline) {
        // First sighting: set the baseline without replaying history — the
        // chart already holds what its getBars calls loaded.
        watch.baseline = fingerprintOf(tail);
        continue;
      }
      for (const bucket of set.buckets) {
        if (bucket.t > watch.baseline.t) {
          onTick(candleToTvBar(bucket));
          watch.baseline = fingerprintOf(bucket);
        } else if (bucket.t === watch.baseline.t) {
          const fp = fingerprintOf(bucket);
          if (
            fp.open !== watch.baseline.open ||
            fp.high !== watch.baseline.high ||
            fp.low !== watch.baseline.low ||
            fp.close !== watch.baseline.close
          ) {
            onTick(candleToTvBar(bucket));
            watch.baseline = fp;
          }
        }
      }
    }
  }

  const datafeed: TvDatafeedChartApi = {
    onReady(callback) {
      // Delivered asynchronously — the library warns on a synchronous
      // callback (it expects a datafeed that resolves out-of-band).
      setTimeout(() => callback(DATAFEED_CONFIG), 0);
    },

    resolveSymbol(_symbolName, onResolve, onError) {
      // Async like onReady — the library warns on a synchronous resolve.
      setTimeout(() => onResolve(symbol), 0);
      void onError; // never fails — the symbol is fixed at construction
    },

    getBars(_symbolInfo, resolution, periodParams, onHistory, onError) {
      const intervalSec = intervalSecFromTv(resolution);
      if (intervalSec === null) {
        onError(`unsupported resolution ${resolution}`);
        return;
      }
      const { fromMs, toMs } = clampHistoryWindow(
        periodParams.from * 1000,
        periodParams.to * 1000,
        intervalSec,
      );
      void client
        .getCandles(gpuId, intervalSec, fromMs, toMs)
        .then((res) => {
          // Seed the store so stats/realtime share this series (and no
          // duplicate GET is issued by the desk's own warm-up).
          feed.ingestCandles(gpuId, res, fromMs);
          onHistory(res.candles.map(candleToTvBar), { noData: res.candles.length === 0 });
        })
        .catch((cause: unknown) => onError(String(cause)));
    },

    subscribeBars(_symbolInfo, resolution, onTick, listenerGuid) {
      const intervalSec = intervalSecFromTv(resolution);
      if (intervalSec === null) return;
      const range = chartRangeForInterval(intervalSec);
      // Warm the store so the watch has a series to read even when the
      // desk's snapshot hasn't loaded this interval yet. Dedup + cooldown
      // are the store's own.
      if (range) {
        feed.ensureCandles(gpuId, intervalSec, Date.now() - RANGE_WINDOW_MS[range]);
      }
      watches.set(intervalSec, watches.get(intervalSec) ?? { baseline: null, seenFirstT: null, seenLength: 0 });
      sinks.set(listenerGuid, { intervalSec, onTick });
      ensureStoreSubscription();
    },

    unsubscribeBars(listenerGuid) {
      sinks.delete(listenerGuid);
      if (sinks.size === 0 && storeUnsubscribe) {
        storeUnsubscribe();
        storeUnsubscribe = null;
        watches.clear();
      }
    },

    getServerTime(callback) {
      // Local clock: the chart's "now" only anchors the trailing bar; the
      // bars themselves carry the server's own timestamps.
      callback(Math.floor(Date.now() / 1000));
    },
  };
  return { datafeed, dispose };
}

// -- mock mode ---------------------------------------------------------------

function createMockDatafeed(port: MarketDataPort, options: TvDatafeedOptions): TvDatafeedHandle {
  const symbol = symbolInfoFor(options);
  const { asset } = options;
  const sinks = new Map<string, { intervalSec: number; onTick: (bar: TvBar) => void }>();
  const baselines = new Map<number, BarFingerprint>();
  let portUnsubscribe: (() => void) | null = null;

  /** The mock universe fabricates one series per range at its own grain; a
   *  bucket the port didn't generate does not exist. Documented compromise:
   *  demo charts every resolution from the snapshot's own candles — the
   *  build stays network-free and the data never claims oracle truth. */
  function snapshotCandles(intervalSec: number): CandleDto[] {
    const range = chartRangeForInterval(intervalSec);
    if (!range) return [];
    const snapshot = port.getSnapshot(asset, range);
    return snapshot
      ? snapshot.candles.map((c) => ({ t: c.t, open: c.open, high: c.high, low: c.low, close: c.close, samples: 0 }))
      : [];
  }

  function fanOut(): void {
    for (const { intervalSec, onTick } of sinks.values()) {
      const buckets = snapshotCandles(intervalSec);
      const tail = buckets[buckets.length - 1];
      if (!tail) continue;
      const baseline = baselines.get(intervalSec);
      if (!baseline) {
        baselines.set(intervalSec, fingerprintOf(tail));
        continue;
      }
      const fp = fingerprintOf(tail);
      if (fp.t > baseline.t || fp.close !== baseline.close) {
        onTick(candleToTvBar(tail));
        baselines.set(intervalSec, fp);
      }
    }
  }

  const datafeed: TvDatafeedChartApi = {
    onReady(callback) {
      setTimeout(() => callback(DATAFEED_CONFIG), 0);
    },

    resolveSymbol(_symbolName, onResolve) {
      setTimeout(() => onResolve(symbol), 0);
    },

    getBars(_symbolInfo, resolution, periodParams, onHistory, onError) {
      const intervalSec = intervalSecFromTv(resolution);
      if (intervalSec === null) {
        onError(`unsupported resolution ${resolution}`);
        return;
      }
      const fromMs = periodParams.from * 1000;
      const toMs = periodParams.to * 1000;
      const bars = snapshotCandles(intervalSec)
        .filter((b) => b.t >= fromMs && b.t <= toMs)
        .map(candleToTvBar);
      onHistory(bars, { noData: bars.length === 0 });
    },

    subscribeBars(_symbolInfo, resolution, onTick, listenerGuid) {
      const intervalSec = intervalSecFromTv(resolution);
      if (intervalSec === null) return;
      sinks.set(listenerGuid, { intervalSec, onTick });
      if (!portUnsubscribe) portUnsubscribe = port.subscribe(() => fanOut());
    },

    unsubscribeBars(listenerGuid) {
      sinks.delete(listenerGuid);
      if (sinks.size === 0 && portUnsubscribe) {
        portUnsubscribe();
        portUnsubscribe = null;
        baselines.clear();
      }
    },
  };
  return {
    datafeed,
    dispose() {
      sinks.clear();
      baselines.clear();
      if (portUnsubscribe) {
        portUnsubscribe();
        portUnsubscribe = null;
      }
    },
  };
}
