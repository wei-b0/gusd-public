import { describe, expect, it, vi } from "vitest";
import {
  candleToTvBar,
  chartRangeForInterval,
  clampHistoryWindow,
  createTvDatafeed,
  intervalSecFromTv,
  RANGE_TO_TV,
  tvResolution,
} from "./tv-feed";
import type { CandlesResponse } from "./dto";
import type { OracleClient } from "./client";
import type { OracleFeedStore } from "./feed";
import type { MarketDataPort } from "@/domain/ports";
import type { Candle, ChartRange, MarketSnapshot } from "@/domain/types";
import type { TvBar, TvDatafeedConfiguration, TvPeriodParams, TvSymbolInfo } from "@/types/tradingview";

/**
 * The TV datafeed's pure surface: resolution mapping (domain range ⇄ TV
 * string), the wire-bucket → bar conversion, the history-window clamp, and
 * the getBars/subscribeBars contracts over stubbed oracle/mock deps. The
 * folding itself is fold.test.ts's subject; here the assertion is that the
 * datafeed serves the store's buckets untouched.
 */

// -- stubs -------------------------------------------------------------------

const symbolInfo = {} as TvSymbolInfo;

const periodParams = (from: number, to: number): TvPeriodParams => ({
  from,
  to,
  countBack: 100,
  firstDataRequest: true,
});

const bucketOf = (t: number, o: number, h: number, l: number, c: number): Candle => ({
  t,
  open: o,
  high: h,
  low: l,
  close: c,
});

/** A port stub whose snapshot the test can rewrite between ticks. */
function stubPort(initial: Candle[]): MarketDataPort & { emit(): void; setCandles(next: Candle[]): void } {
  let candles = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => ({ candles } as unknown as MarketSnapshot),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: () => listeners.forEach((l) => l()),
    setCandles: (next: Candle[]) => {
      candles = next;
    },
  } as unknown as MarketDataPort & { emit(): void; setCandles(next: Candle[]): void };
}

/** An oracle feed stub with a mutable candle state and a manual trigger. */
function stubFeed() {
  const calls = { ingested: 0, warmed: 0 };
  let state: { candles: Record<string, Record<string, { buckets: CandlesResponse["candles"] }>> } = { candles: {} };
  let listener: (() => void) | null = null;
  const feed = {
    getState: () => state,
    subscribe: (l: () => void) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
    ensureCandles: () => {
      calls.warmed += 1;
    },
    ingestCandles: () => {
      calls.ingested += 1;
      return false;
    },
    trigger: () => listener?.(),
    setState: (next: typeof state) => {
      state = next;
    },
    calls,
  };
  return feed as unknown as OracleFeedStore & typeof feed;
}

const candlesResponse: CandlesResponse = {
  gpuId: "H100_SXM_80GB",
  panelId: "panel",
  intervalSec: 300,
  from: new Date(0).toISOString(),
  to: new Date(3_000_000).toISOString(),
  candles: [{ t: 0, open: 10, high: 12, low: 9, close: 11, samples: 3 }],
};

function stubClient(impl: OracleClient["getCandles"]) {
  return { getCandles: vi.fn(impl) } as unknown as OracleClient & { getCandles: ReturnType<typeof vi.fn> };
}

// -- resolution maps ---------------------------------------------------------

describe("onReady", () => {
  it.each(["oracle", "mock"] as const)(
    "%s: delivers a configuration object, never a bare callback",
    async (mode) => {
      // The library stores the onReady argument as its global
      // configurationData and reads .is_tradingview_data unguarded — a bare
      // callback() is the blank-chart bug.
      const deps =
        mode === "mock"
          ? { mode, port: stubPort([]) }
          : { mode, feed: stubFeed(), client: stubClient(async () => candlesResponse) };
      const { datafeed } = createTvDatafeed(deps, { asset: "H100", gpuId: "H100_SXM_80GB" });
      const config = await new Promise<TvDatafeedConfiguration>((resolve, reject) => {
        datafeed.onReady((c) => resolve(c));
        setTimeout(() => reject(new Error("onReady never called back")), 500);
      });
      expect(config.supported_resolutions).toEqual(Object.values(RANGE_TO_TV));
      expect(config.supports_search).toBe(false);
      expect(config.supports_group_request).toBe(false);
    },
  );
});

// -- resolution maps ---------------------------------------------------------

describe("resolution maps", () => {
  it("names a TV resolution for every domain range, uniquely", () => {
    const values = Object.values(RANGE_TO_TV);
    expect(new Set(values).size).toBe(values.length);
    for (const range of Object.keys(RANGE_TO_TV) as ChartRange[]) {
      expect(tvResolution(range), range).toBeTypeOf("string");
    }
  });

  it("inverts through the domain intervals", () => {
    for (const [range, tv] of Object.entries(RANGE_TO_TV)) {
      expect(intervalSecFromTv(tv), tv).toBeTypeOf("number");
      expect(chartRangeForInterval(intervalSecFromTv(tv)!)).toBe(range as ChartRange);
    }
  });

  it("refuses an unsupported resolution rather than guessing", () => {
    expect(intervalSecFromTv("999")).toBeNull();
    expect(chartRangeForInterval(12345)).toBeNull();
  });
});

// -- bar mapping -------------------------------------------------------------

describe("candleToTvBar", () => {
  it("passes the interval-open epoch-ms through untouched", () => {
    // The library consumes bar times as epoch MILLISECONDS (its reference
    // datafeeds pass ms open times straight through and compare against
    // `periodParams.to * 1000`). Dividing to seconds here anchored every bar
    // in 1970 — blank pane, ∅ legend, and 10-digit continuation requests the
    // server 400'd. This assertion pins the ms contract.
    const bar = candleToTvBar({ t: 1_700_000_000_123, open: 10, high: 12, low: 9, close: 11, samples: 3 });
    expect(bar).toEqual({ time: 1_700_000_000_123, open: 10, high: 12, low: 9, close: 11 });
  });

  it("carries audit fields no further than the chart", () => {
    const bar = candleToTvBar({ t: 0, open: 1, high: 1, low: 1, close: 1, samples: 0, carried: true });
    expect(Object.keys(bar).sort()).toEqual(["close", "high", "low", "open", "time"]);
  });
});

// -- history window clamp ------------------------------------------------------

describe("clampHistoryWindow", () => {
  it("keeps a window inside the bucket cap", () => {
    const toMs = 3_000_000_000;
    const fromMs = toMs - 100 * 300_000;
    expect(clampHistoryWindow(fromMs, toMs, 300)).toEqual({ fromMs, toMs });
  });

  it("clamps a scroll-back past the 2000-bucket cap", () => {
    const toMs = 3_000_000_000;
    const fromMs = toMs - 5000 * 300_000;
    expect(clampHistoryWindow(fromMs, toMs, 300)).toEqual({ fromMs: toMs - 2000 * 300_000, toMs });
  });
});

// -- mock-mode datafeed --------------------------------------------------------

describe("mock datafeed", () => {
  const candles = Array.from({ length: 10 }, (_, i) => bucketOf(i * 300_000, 10, 12, 9, 11));

  it("serves getBars from the snapshot's candles, filtered to the window", () => {
    const port = stubPort(candles);
    const { datafeed } = createTvDatafeed({ mode: "mock", port }, { asset: "H100", gpuId: "H100_SXM_80GB" });
    const onHistory = vi.fn();
    const onError = vi.fn();
    datafeed.getBars(symbolInfo, "5", periodParams(0, 3_000), onHistory, onError);
    expect(onError).not.toHaveBeenCalled();
    const [bars, meta] = onHistory.mock.calls[0]!;
    expect(bars).toHaveLength(10);
    expect(bars[0]).toEqual({ time: 0, open: 10, high: 12, low: 9, close: 11 });
    expect(meta).toEqual({ noData: false });
  });

  it("reports noData for an empty series instead of erroring", () => {
    const port = stubPort([]);
    const { datafeed } = createTvDatafeed({ mode: "mock", port }, { asset: "H100", gpuId: "H100_SXM_80GB" });
    const onHistory = vi.fn();
    datafeed.getBars(symbolInfo, "5", periodParams(0, 3_000), onHistory, vi.fn());
    expect(onHistory).toHaveBeenCalledWith([], { noData: true });
  });

  it("emits the tail bar when the snapshot changes, after a quiet baseline", () => {
    const port = stubPort(candles);
    const { datafeed, dispose } = createTvDatafeed({ mode: "mock", port }, { asset: "H100", gpuId: "H100_SXM_80GB" });
    const ticks: TvBar[] = [];
    datafeed.subscribeBars(symbolInfo, "5", (bar) => ticks.push(bar), "guid");

    port.emit(); // first sighting — baseline set, no replay
    expect(ticks).toHaveLength(0);

    const revised = candles.slice();
    revised[9] = bucketOf(9 * 300_000, 10, 12, 9, 12.5);
    port.setCandles(revised);
    port.emit();
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toEqual({ time: 9 * 300_000, open: 10, high: 12, low: 9, close: 12.5 });

    dispose();
  });

  it("stops listening after dispose", () => {
    const port = stubPort(candles);
    const { datafeed, dispose } = createTvDatafeed({ mode: "mock", port }, { asset: "H100", gpuId: "H100_SXM_80GB" });
    const ticks: TvBar[] = [];
    datafeed.subscribeBars(symbolInfo, "5", (bar) => ticks.push(bar), "guid");
    dispose();
    port.emit();
    const revised = candles.slice();
    revised[9] = bucketOf(9 * 300_000, 10, 12, 9, 12.5);
    port.setCandles(revised);
    port.emit();
    expect(ticks).toHaveLength(0);
  });
});

// -- oracle-mode datafeed ------------------------------------------------------

describe("oracle datafeed", () => {
  it("fetches history REST-only, clamped to the bucket cap, and seeds the store", async () => {
    const client = stubClient(async () => candlesResponse);
    const feed = stubFeed();
    const { datafeed } = createTvDatafeed(
      { mode: "oracle", feed, client },
      { asset: "H100", gpuId: "H100_SXM_80GB" },
    );
    const onHistory = vi.fn();
    const onError = vi.fn();
    // 2500 buckets requested → clamped to the server's 2000-bucket window.
    datafeed.getBars(symbolInfo, "5", periodParams(0, 750_000), onHistory, onError);
    await vi.waitFor(() => expect(onHistory).toHaveBeenCalled());

    const [gpuId, intervalSec, fromMs, toMs] = client.getCandles.mock.calls[0]!;
    expect(gpuId).toBe("H100_SXM_80GB");
    expect(intervalSec).toBe(300);
    expect(toMs).toBe(750_000_000);
    expect(fromMs).toBe(750_000_000 - 2000 * 300_000);
    expect(onError).not.toHaveBeenCalled();
    expect(onHistory.mock.calls[0]![0]).toEqual([{ time: 0, open: 10, high: 12, low: 9, close: 11 }]);
    expect(onHistory.mock.calls[0]![1]).toEqual({ noData: false });
    expect(feed.calls.ingested).toBe(1);
  });

  it("surfaces a REST failure as a datafeed error, never a hang", async () => {
    const client = stubClient(async () => {
      throw new Error("boom");
    });
    const { datafeed } = createTvDatafeed(
      { mode: "oracle", feed: stubFeed(), client },
      { asset: "H100", gpuId: "H100_SXM_80GB" },
    );
    const onError = vi.fn();
    datafeed.getBars(symbolInfo, "5", periodParams(0, 3_000), vi.fn(), onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(String(onError.mock.calls[0]![0])).toContain("boom");
  });

  it("errors on an unsupported resolution without touching the client", () => {
    const client = stubClient(async () => candlesResponse);
    const { datafeed } = createTvDatafeed(
      { mode: "oracle", feed: stubFeed(), client },
      { asset: "H100", gpuId: "H100_SXM_80GB" },
    );
    const onError = vi.fn();
    datafeed.getBars(symbolInfo, "999", periodParams(0, 3_000), vi.fn(), onError);
    expect(onError).toHaveBeenCalled();
    expect(client.getCandles).not.toHaveBeenCalled();
  });

  it("warms the store on subscribe and folds store commits into ticks", () => {
    const client = stubClient(async () => candlesResponse);
    const feed = stubFeed();
    const { datafeed, dispose } = createTvDatafeed(
      { mode: "oracle", feed, client },
      { asset: "H100", gpuId: "H100_SXM_80GB" },
    );
    const ticks: TvBar[] = [];
    datafeed.subscribeBars(symbolInfo, "5", (bar) => ticks.push(bar), "guid");
    expect(feed.calls.warmed).toBe(1);

    // First sighting sets the baseline — no replay of history.
    feed.setState({ candles: { H100_SXM_80GB: { "300": { buckets: [{ t: 0, open: 10, high: 12, low: 9, close: 11, samples: 3 }] } } } });
    feed.trigger();
    expect(ticks).toHaveLength(0);

    // A revised trailing bucket (close moved) re-emits that bucket.
    feed.setState({ candles: { H100_SXM_80GB: { "300": { buckets: [{ t: 0, open: 10, high: 12, low: 9, close: 11.5, samples: 4 }] } } } });
    feed.trigger();
    expect(ticks).toEqual([{ time: 0, open: 10, high: 12, low: 9, close: 11.5 }]);

    // A new bucket appends.
    feed.setState({
      candles: {
        H100_SXM_80GB: {
          "300": {
            buckets: [
              { t: 0, open: 10, high: 12, low: 9, close: 11.5, samples: 4 },
              { t: 300_000, open: 11.5, high: 13, low: 11, close: 12, samples: 1 },
            ],
          },
        },
      },
    });
    feed.trigger();
    expect(ticks).toEqual([{ time: 0, open: 10, high: 12, low: 9, close: 11.5 }, { time: 300_000, open: 11.5, high: 13, low: 11, close: 12 }]);

    dispose();
  });

  it("detects a server-side re-bucketing as a reset, not a tick flood", () => {
    const client = stubClient(async () => candlesResponse);
    const feed = stubFeed();
    const onSeriesReset = vi.fn();
    const { datafeed, dispose } = createTvDatafeed(
      { mode: "oracle", feed, client },
      { asset: "H100", gpuId: "H100_SXM_80GB", onSeriesReset },
    );
    const ticks: TvBar[] = [];
    datafeed.subscribeBars(symbolInfo, "5", (bar) => ticks.push(bar), "guid");

    feed.setState({ candles: { H100_SXM_80GB: { "300": { buckets: [{ t: 0, open: 10, high: 12, low: 9, close: 11, samples: 3 }] } } } });
    feed.trigger();
    expect(onSeriesReset).not.toHaveBeenCalled();

    // The refetch moved the first bucket — history was re-bucketed.
    feed.setState({
      candles: {
        H100_SXM_80GB: {
          "300": {
            buckets: [
              { t: 300_000, open: 11, high: 11, low: 11, close: 11, samples: 1 },
              { t: 600_000, open: 11, high: 13, low: 11, close: 12, samples: 1 },
            ],
          },
        },
      },
    });
    feed.trigger();
    expect(onSeriesReset).toHaveBeenCalledWith(300);
    expect(ticks).toHaveLength(0);

    dispose();
  });

  it("releases the store subscription when the last sink unsubscribes", () => {
    const client = stubClient(async () => candlesResponse);
    const feed = stubFeed();
    const { datafeed, dispose } = createTvDatafeed(
      { mode: "oracle", feed, client },
      { asset: "H100", gpuId: "H100_SXM_80GB" },
    );
    datafeed.subscribeBars(symbolInfo, "5", () => {}, "guid");
    datafeed.unsubscribeBars("guid");
    // After the unsubscribe the stub's listener is gone: trigger is a no-op
    // and dispose stays idempotent.
    expect(() => feed.trigger()).not.toThrow();
    expect(() => dispose()).not.toThrow();
  });
});
