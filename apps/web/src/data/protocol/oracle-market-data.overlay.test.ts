/**
 * The composite's protocol overlay, under the four-price-notions doctrine:
 * the indexed store adds ONLY market facts (tape, 24h volume/count, in-range
 * depth) to the enrichment fields. A store wired in must never move a price
 * field — `marketPrice` stays null, the benchmark Index figures stay
 * benchmark-only, candles stay the feed's series — and with the store null
 * the composite's output is byte-identical to the pre-indexer behavior.
 */
import { describe, expect, it, vi } from "vitest";
import type { MarketDataPort } from "@/domain/ports";
import type { Market, MarketSnapshot, MarketTrade } from "@/domain/types";
import type { CandidateDto } from "../oracle/dto";
import type { OracleFeedState, OracleFeedStore } from "../oracle/feed";
import { ORACLE_PANELS } from "../oracle/panel-map";
import { OracleMarketData } from "../oracle/oracle-market-data";
import type { ProtocolMarketStore } from "@/data/protocol/market-store";

const GPU_ID = ORACLE_PANELS.H100.gpuId;
const NOW = 1_700_000_000_000;

function candidate(overrides: Partial<CandidateDto>): CandidateDto {
  return {
    gpuId: GPU_ID,
    panelId: "h100-sxm-80gb",
    price: 3.14,
    confidenceLow: 3.1,
    confidenceHigh: 3.2,
    dispersion: 0.018,
    status: "healthy",
    providersObserved: 8,
    providersContributing: 6,
    methodologyVersion: "1",
    calcHash: "a".repeat(64),
    computedAt: new Date(NOW - 30_000).toISOString(),
    windowStart: new Date(NOW - 1_830_000).toISOString(),
    windowEnd: new Date(NOW - 30_000).toISOString(),
    ...overrides,
  };
}

function fakeFeed(history: CandidateDto[]): OracleFeedStore {
  const latest = history.length > 0 ? history[history.length - 1]! : undefined;
  const state = {
    latest: latest ? { [GPU_ID]: latest } : {},
    history: history.length > 0 ? { [GPU_ID]: history } : {},
    panelProviders: {},
    providers: [],
    candles: {},
    health: null,
    connection: "idle",
    lastDataAt: null,
    lastError: null,
  } as unknown as OracleFeedState;
  return {
    getState: () => state,
    ensureCandles: vi.fn(),
    subscribe: () => () => {},
  } as unknown as OracleFeedStore;
}

function baseMarket(): Market {
  return {
    asset: {
      id: "H100",
      referenceSku: "H100_SXM_80GB",
      vendor: "nvidia",
      vramGb: 80,
      formFactor: "SXM",
      note: "",
    },
    marketPrice: null,
    change24hPct: null,
    change7dPct: null,
    indexPrice: null,
    indexChange24hPct: null,
    basisPct: null,
    indexTelemetry: null,
    volume24hUsd: null,
    liquidityUsd: null,
    sparkline: [],
  };
}

function baseSnapshot(): MarketSnapshot {
  return {
    market: baseMarket(),
    candles: [],
    index: [],
    providers: [],
    recentTrades: [],
    stats: {
      open24h: null,
      high24h: null,
      low24h: null,
      high30d: null,
      low30d: null,
      trades24h: null,
      avgTradeSize: null,
    },
    quality: null,
  };
}

function fakeInner(): MarketDataPort {
  return {
    listMarkets: () => [baseMarket()],
    getSnapshot: () => baseSnapshot(),
    getRecentTrades: () => [],
    subscribe: () => () => {},
  };
}

/** The tape, oldest-first — as the real store serves it. */
const TAPE: MarketTrade[] = [
  { id: `${GPU_ID}:101:1`, side: "buy", size: 1, price: 2, notional: 2, t: NOW - 2_000 },
  { id: `${GPU_ID}:102:1`, side: "sell", size: 2, price: 2.5, notional: 5, t: NOW - 1_000 },
];

function fakeProtocol(withData: boolean): ProtocolMarketStore {
  return {
    subscribe: () => () => {},
    tradesFor: vi.fn(() => (withData ? TAPE : [])),
    volume24hOf: vi.fn(() => (withData ? 123.5 : null)),
    liquidityUsdOf: vi.fn(() => (withData ? 45.25 : null)),
    trades24hOf: vi.fn(() => (withData ? 2 : null)),
  } as unknown as ProtocolMarketStore;
}

describe("OracleMarketData protocol overlay", () => {
  it("with the store null the output is the legacy (pre-indexer) shape", () => {
    const md = new OracleMarketData(fakeInner(), fakeFeed([candidate({})]), null);
    const market = md.listMarkets()[0]!;
    expect(market.volume24hUsd).toBeNull();
    expect(market.liquidityUsd).toBeNull();
    expect(market.marketPrice).toBeNull();
    expect(market.indexPrice).toBe(3.14);

    const snap = md.getSnapshot("H100", "5m");
    expect(snap).not.toBeNull();
    expect(snap!.recentTrades).toHaveLength(0);
    expect(snap!.stats.trades24h).toBeNull();
    expect(snap!.market.marketPrice).toBeNull();
  });

  it("enrichment lands from the store — volume, depth, tape, trade count", () => {
    const md = new OracleMarketData(fakeInner(), fakeFeed([candidate({})]), fakeProtocol(true));
    const market = md.listMarkets()[0]!;
    expect(market.volume24hUsd).toBe(123.5);
    expect(market.liquidityUsd).toBe(45.25);

    const snap = md.getSnapshot("H100", "5m");
    expect(snap!.recentTrades).toBe(TAPE);
    expect(snap!.stats.trades24h).toBe(2);
    // The enrichment never touches a price field or the stats windows.
    expect(snap!.market.marketPrice).toBeNull();
    expect(snap!.stats.high24h).toBeNull();
    expect(snap!.stats.avgTradeSize).toBeNull();
  });

  it("the tape serves OLDEST-FIRST per the port contract", () => {
    const md = new OracleMarketData(fakeInner(), fakeFeed([]), fakeProtocol(true));
    const trades = md.getRecentTrades("H100");
    expect(trades.map((t) => t.id)).toEqual([TAPE[0]!.id, TAPE[1]!.id]);
    expect(trades[0]!.t).toBeLessThan(trades[1]!.t);
  });

  it("doctrine: with the store present marketPrice stays null and the benchmark stays alone", () => {
    const md = new OracleMarketData(fakeInner(), fakeFeed([candidate({})]), fakeProtocol(true));
    const market = md.listMarkets()[0]!;
    // The store never becomes a price: not on the row…
    expect(market.marketPrice).toBeNull();
    expect(market.change24hPct).toBeNull();
    expect(market.basisPct).toBeNull();
    // …and the Index fields stay the benchmark's own.
    expect(market.indexPrice).toBe(3.14);

    const snap = md.getSnapshot("H100", "5m");
    expect(snap!.market.marketPrice).toBeNull();
    expect(snap!.market.basisPct).toBeNull();
    // Charts keep the feed's benchmark series only — the protocol store
    // contributes nothing to the candle arrays.
    expect(snap!.candles).toEqual([]);
    expect(snap!.index).toEqual([]);
  });

  it("a silent store (nulls) leaves the enrichment fields null", () => {
    const md = new OracleMarketData(fakeInner(), fakeFeed([candidate({})]), fakeProtocol(false));
    const market = md.listMarkets()[0]!;
    expect(market.volume24hUsd).toBeNull();
    expect(market.liquidityUsd).toBeNull();
    const snap = md.getSnapshot("H100", "5m");
    expect(snap!.recentTrades).toHaveLength(0);
    expect(snap!.stats.trades24h).toBeNull();
  });
});
