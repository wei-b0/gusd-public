/**
 * Prototype universe generator.
 *
 * Builds the complete deterministic mock dataset: asset specs, 90 days of
 * hourly market candles, aligned Index series, provider observations, recent
 * trades, and market statistics. Everything here is prototype data labeled as
 * such at the shell level; no value claims to be a live market.
 */

import type {
  AssetId,
  AssetSpec,
  Candle,
  ChartRange,
  IndexPoint,
  Market,
  MarketStats,
  MarketTrade,
  ProviderObservation,
} from "@/domain/types";
import { hashSeed, rng } from "./prng";

/**
 * Fixed session anchor for the prototype dataset. Deterministic so SSR and
 * hydration render identical pixels; the live tick loop takes over after
 * mount. Swap for a real feed anchor when the Index integration lands.
 */
export const SESSION_ANCHOR = Date.UTC(2026, 8, 4, 14, 0, 0);
const HOUR = 3_600_000;
const HOUR_POINTS = 90 * 24; // 90 days of hourly closes

export const ASSET_IDS = ["H100", "H200", "B200", "B300", "GB200", "GB300", "A100"] as const;

export const ASSET_SPECS: Record<AssetId, AssetSpec> = {
  H100: {
    id: "H100",
    referenceSku: "NVIDIA H100 SXM 80GB",
    vendor: "nvidia",
    vramGb: 80,
    formFactor: "SXM",
    note: "The most liquid market in the GPU asset class. Deepest book, tightest pricing.",
  },
  H200: {
    id: "H200",
    referenceSku: "NVIDIA H200 SXM 141GB",
    vendor: "nvidia",
    vramGb: 141,
    formFactor: "SXM",
    note: "Hopper with memory headroom; the large-context inference reference.",
  },
  B200: {
    id: "B200",
    referenceSku: "NVIDIA B200 192GB",
    vendor: "nvidia",
    vramGb: 192,
    formFactor: "SXM",
    note: "Blackwell volume configuration; the densest active training exposure.",
  },
  B300: {
    id: "B300",
    referenceSku: "NVIDIA B300 288GB",
    vendor: "nvidia",
    vramGb: 288,
    formFactor: "SXM",
    note: "Blackwell Ultra; thinner rental coverage, wider premium.",
  },
  GB200: {
    id: "GB200",
    referenceSku: "NVIDIA GB200 superchip",
    vendor: "nvidia",
    vramGb: 192,
    formFactor: "SXM",
    note: "Grace-Blackwell node economics; trades as a node-level composite.",
  },
  GB300: {
    id: "GB300",
    referenceSku: "NVIDIA GB300 superchip",
    vendor: "nvidia",
    vramGb: 288,
    formFactor: "SXM",
    note: "Newest capital exposure; shallowest history, widest premium.",
  },
  A100: {
    id: "A100",
    referenceSku: "NVIDIA A100 SXM 80GB",
    vendor: "nvidia",
    vramGb: 80,
    formFactor: "SXM",
    note: "The legacy workhorse; aging rental demand, structurally at a discount.",
  },
};

/** Prototype Index anchors, gUSD per GPU-hour. Plausible-band, clearly synthetic. */
const INDEX_ANCHOR: Record<AssetId, number> = {
  H100: 2.43,
  H200: 2.98,
  B200: 4.42,
  B300: 5.61,
  GB200: 6.31,
  GB300: 7.52,
  A100: 1.41,
};

/** Structural basis the market carries around the Index (percent). */
const BASIS_DRIFT: Record<AssetId, number> = {
  H100: 2.4,
  H200: 1.6,
  B200: 3.1,
  B300: 4.2,
  GB200: 2.8,
  GB300: 5.4,
  A100: -3.6,
};

/** Per-asset seed for the random walk. */
function assetSeed(tag: string): number {
  return hashSeed(`gusd-mock-${tag}`);
}

interface GeneratedSeries {
  market: { t: number; close: number }[];
  index: { t: number; value: number }[];
}

const generated = new Map<AssetId, GeneratedSeries>();

/**
 * Generates the market + Index walk for one asset. The market trades around
 * the Index with basis noise; the Index is a smoother rental-market signal
 * with slower drift and weekly seasonality.
 */
function marketSeries(id: AssetId): GeneratedSeries {
  const cached = generated.get(id);
  if (cached) return cached;

  const r = rng(assetSeed(id));
  const anchor = INDEX_ANCHOR[id];
  const start = SESSION_ANCHOR - HOUR_POINTS * HOUR;
  let index = anchor * (1 - 0.012 * r.range(-1, 1));
  let basis = BASIS_DRIFT[id] / 100;

  const indexCloses: { t: number; value: number }[] = [];
  const marketCloses: { t: number; close: number }[] = [];

  for (let i = 0; i <= HOUR_POINTS; i++) {
    const t = start + i * HOUR;
    const hourOfDay = new Date(t).getUTCHours();
    // Diurnal rental demand: business hours carry more compute demand.
    const diurnal = 1 + 0.02 * Math.sin(((hourOfDay - 6) / 24) * Math.PI * 2);
    // Weekly cycle: weekdays slightly above weekend rental rates.
    const day = new Date(t).getUTCDay();
    const weekly = day === 0 || day === 6 ? 0.992 : 1.004;

    // Index: slow-moving reference.
    index += index * 0.00004 * r.normal(0.15, 1) * diurnal * weekly;
    index = Math.max(index, anchor * 0.55);

    // Basis mean-reverts around its structural drift with market noise.
    basis += (BASIS_DRIFT[id] / 100 - basis) * 0.02 + r.normal(0, 0.0022);
    const market = index * (1 + basis);

    indexCloses.push({ t, value: index });
    marketCloses.push({ t, close: market });
  }

  const out = { market: marketCloses, index: indexCloses };
  generated.set(id, out);
  return out;
}

interface ProviderSpec {
  provider: string;
  weight: number;
  /** Probability this provider sits in the live panel at session open. */
  reliability: number;
}

/** Prototype provider panel. Names are synthetic by design. */
const PROVIDER_POOL: ProviderSpec[] = [
  { provider: "Northfleet", weight: 18, reliability: 0.98 },
  { provider: "Gridcarry", weight: 15, reliability: 0.96 },
  { provider: "Helion Pool", weight: 13, reliability: 0.93 },
  { provider: "Baselayer", weight: 12, reliability: 0.97 },
  { provider: "Opstation", weight: 11, reliability: 0.9 },
  { provider: "Cumulus Nodes", weight: 9, reliability: 0.88 },
  { provider: "Tallgrass Compute", weight: 8, reliability: 0.95 },
  { provider: "Parsec Rentals", weight: 7, reliability: 0.85 },
  { provider: "Quanta Yard", weight: 8, reliability: 0.92 },
  { provider: "Meridian Fleet", weight: 6, reliability: 0.9 },
];

const DESKS = ["arbitrage", "momentum", "systematic", "treasury", "LP-rebalance"] as const;

/** Builds the full Market aggregate for one asset. */
export function buildMarket(id: AssetId): Market {
  const { market, index } = marketSeries(id);
  const last = market[market.length - 1]!;
  const idxLast = index[index.length - 1]!.value;
  const closes = market.map((p) => p.close);

  // Volume scales with liquidity of the class; H100 dominates.
  const liquidityBase: Record<AssetId, number> = {
    H100: 3_800_000,
    H200: 1_450_000,
    B200: 2_600_000,
    B300: 890_000,
    GB200: 1_120_000,
    GB300: 610_000,
    A100: 940_000,
  };
  const r = rng(assetSeed(`vol-${id}`));
  const liquidity = liquidityBase[id] * (1 + r.range(-0.1, 0.1));
  const turnover = liquidity * r.range(0.35, 0.95);

  return {
    asset: ASSET_SPECS[id],
    marketPrice: last.close,
    change24hPct: (last.close / market[market.length - 25]!.close - 1) * 100,
    change7dPct: (last.close / market[market.length - 169]!.close - 1) * 100,
    indexPrice: idxLast,
    indexChange24hPct: (idxLast / index[index.length - 25]!.value - 1) * 100,
    basisPct: (last.close / idxLast - 1) * 100,
    // The simulated universe confesses via indexStatus's absence; it carries
    // no publication telemetry — there is no wire behind it.
    indexTelemetry: null,
    volume24hUsd: turnover,
    liquidityUsd: liquidity,
    sparkline: closes.slice(-48),
  };
}

/**
 * Hourly candles for a range ending at the session anchor. The demo universe
 * synthesizes one hourly series, so every grain's window is expressed in
 * hours — the label stays the selector the real data layer serves.
 */
const RANGE_HOURS: Record<ChartRange, number> = {
  "1m": 48,
  "5m": 72,
  "15m": 96,
  "30m": 120,
  "1h": 132,
  "4h": 156,
  "6h": 168,
  "12h": 240,
  "1d": 336,
  "1w": 480,
};

export function buildCandles(id: AssetId, range: ChartRange): Candle[] {
  const { market } = marketSeries(id);
  const points = RANGE_HOURS[range];
  const slice = market.slice(-points);
  return slice.map((p, i) => {
    const prev = i === 0 ? p.close : slice[i - 1]!.close;
    const spread = p.close * 0.0012;
    return {
      t: p.t,
      open: prev,
      close: p.close,
      high: Math.max(prev, p.close) + spread,
      low: Math.min(prev, p.close) - spread,
    };
  });
}

/** Index reference series aligned to the same window. */
export function buildIndex(id: AssetId, range: ChartRange): IndexPoint[] {
  const { index } = marketSeries(id);
  return index.slice(-RANGE_HOURS[range]);
}

/** Prototype provider observations for one GPU class. */
export function buildProviders(id: AssetId): ProviderObservation[] {
  const r = rng(assetSeed(`providers-${id}`));
  const { index } = marketSeries(id);
  const idx = index[index.length - 1]!.value;

  // Full ten-provider panel. Status follows reliability, ranked: the two least
  // reliable observatories degrade (one stale, one delayed) so the panel reads
  // 9/10 live — consistent with the session strip, on every asset.
  const panel = PROVIDER_POOL;
  const totalWeight = panel.reduce((sum, p) => sum + p.weight, 0);
  const byReliability = [...panel].sort((a, b) => a.reliability - b.reliability);
  const staleName = byReliability[0]!.provider;
  const delayedName = byReliability[1]!.provider;

  return panel.map((p) => {
    // Observations scatter around the Index; dispersion is the provider mix.
    const price = idx * (1 + r.normal(0, 0.035));
    const status: ProviderObservation["status"] =
      p.provider === staleName ? "stale" : p.provider === delayedName ? "delayed" : "live";
    const lagMinutes = status === "stale" ? r.range(26, 90) : status === "delayed" ? r.range(6, 22) : r.range(0.2, 5);
    return {
      id: `${id}-${p.provider.toLowerCase().replace(/\s+/g, "-")}`,
      provider: p.provider,
      priceUsdPerGpuHour: price,
      weightPct: (p.weight / totalWeight) * 100,
      coveragePct: r.range(p.reliability * 92, 99.4),
      lastObservedAt: SESSION_ANCHOR - lagMinutes * 60_000,
      status,
    };
  });
}

/** Recent prototype tape for one market, oldest first (live ticks append). */
export function buildRecentTrades(id: AssetId, count = 14): MarketTrade[] {
  const { market } = marketSeries(id);
  const r = rng(assetSeed(`tape-${id}`));
  const last = market[market.length - 1]!.close;
  const trades: MarketTrade[] = [];
  let cursor = SESSION_ANCHOR;

  for (let i = 0; i < count; i++) {
    cursor -= r.range(20_000, 240_000);
    const price = last * (1 + r.normal(0, 0.0009));
    const size = r.pick([0.5, 1, 1, 2, 2.5, 4, 5, 8, 12, 25]) * (1 + r.range(-0.1, 0.1));
    const side: MarketTrade["side"] = r.next() < 0.52 ? "buy" : "sell";
    trades.push({
      id: `${id}-tape-${i}`,
      side,
      size,
      price,
      notional: size * price,
      t: cursor,
    });
  }
  // The seed walks backward from the session anchor; the tick loop appends
  // forward. Sort ascending so the tape has one convention everywhere.
  return trades.sort((a, b) => a.t - b.t);
}

export function buildStats(id: AssetId): MarketStats {
  const { market } = marketSeries(id);
  const day = market.slice(-25);
  const month = market.slice(-24 * 30);
  const dayCloses = day.map((p) => p.close);
  const monthCloses = month.map((p) => p.close);
  const r = rng(assetSeed(`stats-${id}`));
  return {
    high24h: Math.max(...dayCloses),
    low24h: Math.min(...dayCloses),
    high30d: Math.max(...monthCloses),
    low30d: Math.min(...monthCloses),
    open24h: day[0]!.close,
    trades24h: r.int(340, 2400),
    avgTradeSize: r.range(2.2, 6.8),
  };
}
