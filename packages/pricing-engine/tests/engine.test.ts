import { describe, expect, it } from "vitest";
import type { ProviderPriceResult, ProviderRole } from "@gusd/types";
import { CATALOG } from "@gusd/gpu-catalog";
import {
  DEFAULT_METHODOLOGY_CONFIG,
  aggregateProviderPrice,
  computeIndex,
  validateMethodologyConfig,
  type AggregationObservation,
  type IndexInput,
  type MethodologyConfig,
  type ProviderStat,
} from "../src/index.js";

const GPU = CATALOG.find((g) => g.id === "H100_SXM_80GB")!;

const T0 = new Date("2026-09-04T00:00:00.000Z");
const WINDOW_START = new Date(T0.getTime() - 30 * 60_000);
const WINDOW_END = T0;

// --- fixtures ----------------------------------------------------------------

let priceSeq = 0;
function providerPrice(
  providerId: string,
  price: number | null,
  opts: { executable?: boolean; sampleSize?: number; method?: ProviderPriceResult["method"] } = {},
): ProviderPriceResult {
  priceSeq += 1;
  return {
    providerId,
    gpuId: GPU.id,
    panelId: "H100_PANEL_V1",
    price,
    executable: opts.executable ?? true,
    method: opts.method ?? "volume_weighted_median",
    sampleSize: opts.sampleSize ?? 6,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    computedAt: WINDOW_END,
    methodologyVersion: DEFAULT_METHODOLOGY_CONFIG.version,
    params: {},
    receipts: {
      contributions: [],
      exclusions: [],
      flags: {
        coverageGap: false,
        dedupDroppedCount: 0,
        bidOffersSkipped: 0,
        arithmeticMismatches: 0,
        outOfRangeGpuCounts: 0,
        outOfBandCount: 0,
      },
    },
  };
}

function stat(overrides: Partial<ProviderStat> = {}): ProviderStat {
  return { sigma: 0.02, lastPriceAt: WINDOW_END, trailingMedian: null, ...overrides };
}

function roles(...ids: string[]): ReadonlyMap<string, ProviderRole> {
  return new Map(ids.map((id) => [id, "SETTLEMENT_ELIGIBLE" as const]));
}

function makeInput(
  prices: ProviderPriceResult[],
  opts: {
    stats?: ReadonlyMap<string, ProviderStat>;
    roleMap?: ReadonlyMap<string, ProviderRole>;
    prior?: IndexInput["prior"];
    config?: MethodologyConfig;
    now?: Date;
  } = {},
): IndexInput {
  return {
    gpu: GPU,
    panelId: "H100_PANEL_V1",
    providerPrices: prices,
    providerRoles:
      opts.roleMap ?? roles(...prices.map((p) => p.providerId)),
    providerStats:
      opts.stats ??
      new Map(
        prices.map((p) => [
          p.providerId,
          stat({ trailingMedian: p.price ?? null }),
        ] as const),
      ),
    prior: opts.prior ?? null,
    now: opts.now ?? T0,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    config: opts.config ?? DEFAULT_METHODOLOGY_CONFIG,
  };
}

// === config ==================================================================

describe("validateMethodologyConfig", () => {
  it("accepts the default config", () => {
    expect(validateMethodologyConfig(DEFAULT_METHODOLOGY_CONFIG)).toEqual(
      DEFAULT_METHODOLOGY_CONFIG,
    );
  });

  it("rejects unknown keys (exhaustive allowlist)", () => {
    const bad = { ...DEFAULT_METHODOLOGY_CONFIG, extra: true } as unknown as object;
    expect(() => validateMethodologyConfig(bad)).toThrow(/unknown key/);
  });

  it("rejects missing keys", () => {
    const { weightCap: _wc, ...rest } = DEFAULT_METHODOLOGY_CONFIG;
    expect(() => validateMethodologyConfig(rest)).toThrow(/weightCap.*missing/);
  });

  it("rejects out-of-range values", () => {
    expect(() =>
      validateMethodologyConfig({ ...DEFAULT_METHODOLOGY_CONFIG, weightCap: 1.5 }),
    ).toThrow(/weightCap/);
    expect(() =>
      validateMethodologyConfig({
        ...DEFAULT_METHODOLOGY_CONFIG,
        dispersion: { max: 0.2, warn: 0.45 },
      }),
    ).toThrow(/dispersion\.warn/);
    expect(() =>
      validateMethodologyConfig({
        ...DEFAULT_METHODOLOGY_CONFIG,
        aggregation: { ...DEFAULT_METHODOLOGY_CONFIG.aggregation, eligibleTiers: ["nope"] },
      }),
    ).toThrow(/eligibleTiers/);
  });
});

// === aggregateProviderPrice ===================================================

function orderBookRow(
  overrides: Partial<AggregationObservation> = {},
): AggregationObservation {
  return {
    offerId: "offer-1",
    machineId: "machine-1",
    hostId: "host-1",
    usdPerGpuHour: 2.0,
    rawTotalUsdPerHour: null,
    pricingTier: "on_demand",
    gpuCount: 1,
    isBid: false,
    available: true,
    region: "us-west",
    observedAt: WINDOW_END,
    ...overrides,
  };
}

function aggInput(
  observations: AggregationObservation[],
  overrides: Partial<Parameters<typeof aggregateProviderPrice>[0]> = {},
) {
  return {
    providerId: "vast",
    gpu: GPU,
    panelId: "H100_PANEL_V1",
    observations,
    executable: true,
    coverageGap: false,
    config: DEFAULT_METHODOLOGY_CONFIG.aggregation,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    computedAt: WINDOW_END,
    methodologyVersion: DEFAULT_METHODOLOGY_CONFIG.version,
    ...overrides,
  };
}

describe("aggregateProviderPrice — order book", () => {
  const fullBook = (): AggregationObservation[] => {
    const machines = ["m1", "m2", "m3", "m4", "m5", "m6"];
    const hosts = ["h1", "h1", "h2", "h2", "h3", "h3"];
    const prices = [1.95, 2.0, 2.05, 2.1, 2.15, 2.2];
    return machines.map((m, i) =>
      orderBookRow({
        machineId: m,
        hostId: hosts[i]!,
        offerId: `o${i}`,
        usdPerGpuHour: prices[i]!,
      }),
    );
  };

  it("prices a healthy book via volume-weighted median, executable", () => {
    const r = aggregateProviderPrice(aggInput(fullBook()));
    expect(r.price).not.toBeNull();
    expect(r.method).toBe("volume_weighted_median");
    expect(r.executable).toBe(true);
    expect(r.sampleSize).toBe(6);
    expect(r.receipts.holdout).toBeUndefined();
    // 6 machines × 1 GPU each → weight 1 each; weighted median crosses half
    // of total weight (3) at the 3rd cheapest offer: 2.05.
    expect(r.price).toBe(2.05);
  });

  it("weights by gpu count (capped at 16) in the median", () => {
    const rows = [
      orderBookRow({ machineId: "m1", hostId: "h1", offerId: "o1", gpuCount: 8, usdPerGpuHour: 1.5 }),
      orderBookRow({ machineId: "m2", hostId: "h1", offerId: "o2", gpuCount: 8, usdPerGpuHour: 1.6 }),
      orderBookRow({ machineId: "m3", hostId: "h2", offerId: "o3", gpuCount: 1, usdPerGpuHour: 9 }),
      orderBookRow({ machineId: "m4", hostId: "h2", offerId: "o4", gpuCount: 1, usdPerGpuHour: 9.1 }),
      orderBookRow({ machineId: "m5", hostId: "h3", offerId: "o5", gpuCount: 1, usdPerGpuHour: 9.2 }),
    ];
    const r = aggregateProviderPrice(aggInput(rows));
    // total weight 19; half = 9.5 → 8+8 reaches it at 1.6
    expect(r.price).toBe(1.6);
  });

  it("keeps the cheapest offer per machine and counts dedup drops", () => {
    const rows = [
      ...fullBook(),
      orderBookRow({ machineId: "m1", hostId: "h1", offerId: "o-dup", usdPerGpuHour: 2.5 }),
      orderBookRow({ machineId: "m1", hostId: "h1", offerId: "o-cheap", usdPerGpuHour: 1.9 }),
    ];
    const r = aggregateProviderPrice(aggInput(rows));
    expect(r.receipts.flags.dedupDroppedCount).toBe(2);
    expect(r.sampleSize).toBe(6);
    // cheapest for m1 is now 1.9; weighted median crosses half at 2.05
    expect(r.price).toBe(2.05);
  });

  it("skips bid offers", () => {
    const rows = fullBook().map((o, i) =>
      i === 0 ? { ...o, isBid: true, usdPerGpuHour: 0.1 } : o,
    );
    const r = aggregateProviderPrice(aggInput(rows));
    expect(r.receipts.flags.bidOffersSkipped).toBe(1);
    expect(r.sampleSize).toBe(5);
  });

  it("never defaults gpu count: missing and out-of-range rows are excluded", () => {
    const rows = [
      orderBookRow({ machineId: "m1", hostId: "h1", offerId: "o1", gpuCount: null }),
      orderBookRow({ machineId: "m2", hostId: "h1", offerId: "o2", gpuCount: 0 }),
      orderBookRow({ machineId: "m3", hostId: "h2", offerId: "o3", gpuCount: 24 }),
      ...fullBook().slice(3),
    ];
    const r = aggregateProviderPrice(aggInput(rows));
    expect(r.receipts.flags.outOfRangeGpuCounts).toBe(3);
    const reasons = r.receipts.exclusions.map((e) => e.reason);
    expect(reasons).toContain("gpu_count_out_of_range");
  });

  it("arithmetic tripwire: perGpu×n must match the stated total", () => {
    const rows = fullBook().map((o, i) =>
      i === 0
        ? { ...o, gpuCount: 4, usdPerGpuHour: 2.0, rawTotalUsdPerHour: 3.0 }
        : o,
    );
    const r = aggregateProviderPrice(aggInput(rows));
    expect(r.receipts.flags.arithmeticMismatches).toBe(1);
    expect(r.receipts.exclusions.find((e) => e.reason === "arithmetic_mismatch")).toBeDefined();
  });

  it("arithmetic tripwire passes within tolerance", () => {
    const rows = fullBook().map((o, i) =>
      i === 0
        ? { ...o, gpuCount: 4, usdPerGpuHour: 2.0, rawTotalUsdPerHour: 8.0 + 4 * 0.004 }
        : o,
    );
    const r = aggregateProviderPrice(aggInput(rows));
    expect(r.receipts.flags.arithmeticMismatches).toBe(0);
  });

  it("excludes prices outside the SKU plausible band", () => {
    const rows = [
      orderBookRow({ machineId: "m1", hostId: "h1", offerId: "o1", usdPerGpuHour: 999 }),
      ...fullBook().slice(1),
    ];
    const r = aggregateProviderPrice(aggInput(rows));
    expect(r.receipts.flags.outOfBandCount).toBe(1);
  });

  it("holds out a thin book instead of pricing it", () => {
    const rows = [0, 1, 2].map((i) => orderBookRow({ machineId: `m${i}`, hostId: `h${i}` }));
    const r = aggregateProviderPrice(aggInput(rows));
    expect(r.price).toBeNull();
    expect(r.method).toBe("thin_book_holdout");
    expect(r.receipts.holdout?.reason).toBe("thin_book");
  });

  it("falls back to machine-as-host when no host ids are published", () => {
    const rows = fullBook().map((o, i) => ({ ...o, hostId: null }));
    const r = aggregateProviderPrice(aggInput(rows));
    expect(r.price).not.toBeNull();
    expect(r.params.observedHosts).toBe(6);
  });

  it("fails closed when only some rows carry host ids", () => {
    const rows = fullBook().map((o, i) => (i < 5 ? { ...o, hostId: null } : o));
    const r = aggregateProviderPrice(aggInput(rows));
    expect(r.price).toBeNull();
    expect(r.receipts.holdout?.reason).toBe("thin_book");
  });

  it("excludes unavailable rows", () => {
    const rows = fullBook().map((o, i) => (i === 0 ? { ...o, available: false } : o));
    const r = aggregateProviderPrice(aggInput(rows));
    expect(r.receipts.exclusions.map((e) => e.reason)).toContain("unavailable");
    expect(r.sampleSize).toBe(5);
  });

  it("empty input is a holdout, not zero", () => {
    const r = aggregateProviderPrice(aggInput([]));
    expect(r.price).toBeNull();
    expect(r.receipts.holdout?.reason).toBe("no_usd_observations");
  });

  it("all rows filtered is a holdout, not zero", () => {
    const rows = fullBook().map((o) => ({ ...o, isBid: true }));
    const r = aggregateProviderPrice(aggInput(rows));
    expect(r.price).toBeNull();
    expect(r.receipts.holdout?.reason).toBe("all_filtered");
  });

  it("propagates the coverageGap flag (ASC+DESC truncation detection)", () => {
    const r = aggregateProviderPrice(aggInput(fullBook(), { coverageGap: true }));
    expect(r.receipts.flags.coverageGap).toBe(true);
  });
});

describe("aggregateProviderPrice — rate card", () => {
  const rateRow = (over: Partial<AggregationObservation> = {}): AggregationObservation =>
    orderBookRow({
      machineId: null,
      hostId: null,
      offerId: `sku-${Math.random().toString(36).slice(2, 7)}`,
      gpuCount: null,
      rawTotalUsdPerHour: null,
      ...over,
    });

  it("medians tier-eligible rows only", () => {
    const rows = [
      rateRow({ usdPerGpuHour: 2.0, pricingTier: "on_demand", offerId: "a" }),
      rateRow({ usdPerGpuHour: 2.1, pricingTier: "on_demand", offerId: "b" }),
      rateRow({ usdPerGpuHour: 0.9, pricingTier: "spot", offerId: "c" }),
      rateRow({ usdPerGpuHour: 1.2, pricingTier: "committed", offerId: "d" }),
      rateRow({ usdPerGpuHour: 2.2, pricingTier: "on_demand", offerId: "e" }),
    ];
    const r = aggregateProviderPrice(aggInput(rows));
    expect(r.method).toBe("median");
    expect(r.price).toBe(2.1);
    expect(r.receipts.exclusions.filter((e) => e.reason === "tier_not_eligible")).toHaveLength(2);
    expect(r.executable).toBe(true); // passes through the registry flag
  });

  it("unknown tier is excluded, not defaulted", () => {
    const rows = [
      rateRow({ usdPerGpuHour: 2.0, pricingTier: null, offerId: "a" }),
      rateRow({ usdPerGpuHour: 2.0, pricingTier: "on_demand", offerId: "b" }),
      rateRow({ usdPerGpuHour: 2.0, pricingTier: "on_demand", offerId: "c" }),
    ];
    const r = aggregateProviderPrice(aggInput(rows));
    expect(r.price).toBe(2.0);
    expect(r.sampleSize).toBe(2);
    expect(r.receipts.exclusions[0]!.reason).toBe("tier_not_eligible");
  });
});

// === computeIndex =============================================================

describe("computeIndex", () => {
  it("produces a healthy index with a confidence band and all gates passed", () => {
    const prices = ["a", "b", "c", "d", "e"].map((id, i) =>
      providerPrice(id, [1.98, 2.0, 2.0, 2.02, 2.04][i]!),
    );
    const r = computeIndex(makeInput(prices));
    expect(r.status).toBe("healthy");
    expect(r.price).toBe(2.008);
    expect(r.confidenceLow).not.toBeNull();
    expect(r.confidenceHigh).not.toBeNull();
    expect(r.confidenceLow!).toBeLessThanOrEqual(r.price!);
    expect(r.confidenceHigh!).toBeGreaterThanOrEqual(r.price!);
    expect(r.providersObserved).toBe(5);
    expect(r.providersContributing).toBe(5);
    expect(r.gates.every((g) => g.passed)).toBe(true);
    expect(r.exclusions).toHaveLength(0);
  });

  it("watchdog data cannot leak: non-eligible providers never contribute", () => {
    const roleMap = new Map<string, ProviderRole>([
      ["gputable", "WATCHDOG_ONLY"],
      ["a", "SETTLEMENT_ELIGIBLE"],
      ["b", "SETTLEMENT_ELIGIBLE"],
      ["c", "SETTLEMENT_ELIGIBLE"],
      ["d", "SETTLEMENT_ELIGIBLE"],
    ]);
    const prices = [
      providerPrice("gputable", 0.5),
      ...["a", "b", "c", "d"].map((id) => providerPrice(id, 2.0)),
    ];
    const r = computeIndex(makeInput(prices, { roleMap }));
    expect(r.status).toBe("healthy");
    expect(r.contributors.map((c) => c.providerId)).not.toContain("gputable");
    expect(r.exclusions.find((e) => e.reason === "role_not_settlement_eligible")).toBeDefined();
    expect(r.price).toBe(2.0);
  });

  it("screens a massive high outlier (MAD>0 path)", () => {
    const prices = [2, 2.5, 3, 3.5, 4, 100].map((p, i) => providerPrice(`p${i}`, p));
    const r = computeIndex(makeInput(prices));
    const excluded = r.exclusions.filter((e) => e.reason === "mad_outlier");
    expect(excluded.map((e) => e.providerId)).toEqual(["p5"]);
    expect(r.contributors).toHaveLength(5);
    expect(r.status).toBe("healthy");
  });

  it("screens a MAD=0 tie consensus via the ratio band", () => {
    // 5 providers tied at 3.00 (MAD = 0) plus one at 9.50 — the σ screen is
    // vacuous here; the 3× ratio band must catch the 9.50.
    const prices = [3, 3, 3, 3, 3, 9.5].map((p, i) => providerPrice(`p${i}`, p));
    const r = computeIndex(makeInput(prices));
    const excluded = r.exclusions.filter((e) => e.reason === "mad_zero_ratio_band");
    expect(excluded.map((e) => e.providerId)).toEqual(["p5"]);
    expect(r.price).toBe(3);
    expect(r.dispersion).toBe(0);
  });

  it("screens a massive low outlier symmetrically", () => {
    // median 4.0, MAD 0.75 → limit 3·1.4826·0.75 ≈ 3.336; |0.01 − 4| = 3.99
    const prices = [3, 3.5, 4, 4.5, 5, 0.01].map((p, i) => providerPrice(`p${i}`, p));
    const r = computeIndex(makeInput(prices));
    const excluded = r.exclusions.filter((e) => e.reason === "mad_outlier");
    expect(excluded.map((e) => e.providerId)).toEqual(["p5"]);
  });

  it("excludes an uncorroborated provider jump vs its own trailing median", () => {
    const stats = new Map<string, ProviderStat>([
      ["jumper", stat({ trailingMedian: 2.0 })],
      ...["a", "b", "c", "d"].map((id) => [id, stat({ trailingMedian: 2.0 })] as const),
    ]);
    const prices = [providerPrice("jumper", 2.6), ...["a", "b", "c", "d"].map((id) => providerPrice(id, 2.0))];
    const r = computeIndex(makeInput(prices, { stats }));
    const jumped = r.exclusions.filter((e) => e.reason === "jump_screen");
    expect(jumped.map((e) => e.providerId)).toEqual(["jumper"]);
    expect(r.contributors.map((c) => c.providerId)).not.toContain("jumper");
  });

  it("keeps a jump corroborated by other providers moving ≥10%", () => {
    const stats = new Map<string, ProviderStat>(
      ["jumper", "a", "b", "c", "d"].map((id) => [
        id,
        stat({ trailingMedian: 2.0 }),
      ] as const),
    );
    const prices = [
      providerPrice("jumper", 2.7), // +35%
      providerPrice("a", 2.4), // +20% corroborator
      providerPrice("b", 2.35), // +17.5% corroborator
      providerPrice("c", 2.0),
      providerPrice("d", 2.0),
    ];
    const r = computeIndex(makeInput(prices, { stats }));
    expect(r.exclusions.filter((e) => e.reason === "jump_screen")).toHaveLength(0);
    expect(r.contributors).toHaveLength(5);
  });

  it("stays silent on the jump screen when too few providers are comparable (starvation guard)", () => {
    const stats = new Map<string, ProviderStat>([
      ["jumper", stat({ trailingMedian: 2.0 })],
      ["a", stat({ trailingMedian: 2.0 })],
      ["b", stat({ trailingMedian: null })],
      ["c", stat({ trailingMedian: null })],
      ["d", stat({ trailingMedian: null })],
    ]);
    const prices = [providerPrice("jumper", 9), providerPrice("a", 2), ...["b", "c", "d"].map((id) => providerPrice(id, 2))];
    const r = computeIndex(makeInput(prices, { stats }));
    // The jump screen must not fire (2 comparable < 3), but the MAD screen
    // still catches the 9.0 once armed — here via the MAD=0 ratio band,
    // since the four tied 2.0s make the deviations' median zero.
    expect(r.exclusions.filter((e) => e.reason === "jump_screen")).toHaveLength(0);
    const screened = r.exclusions.filter(
      (e) => e.reason === "mad_outlier" || e.reason === "mad_zero_ratio_band",
    );
    expect(screened.map((e) => e.providerId)).toEqual(["jumper"]);
  });

  it("caps a dominating provider at 35% of total weight", () => {
    const prices = [
      providerPrice("big", 2.0, { executable: true }),
      providerPrice("small1", 2.0, { executable: false }),
      providerPrice("small2", 2.0, { executable: false }),
    ];
    const r = computeIndex(makeInput(prices, { config: { ...DEFAULT_METHODOLOGY_CONFIG, gates: { ...DEFAULT_METHODOLOGY_CONFIG.gates, requireExecutable: false } } }));
    const big = r.contributors.find((c) => c.providerId === "big")!;
    const total = r.contributors.reduce((a, c) => a + c.weightAfterCap, 0);
    expect(big.weightAfterCap / total).toBeLessThanOrEqual(DEFAULT_METHODOLOGY_CONFIG.weightCap + 1e-9);
    expect(big.weightBeforeCap).toBe(1.0);
    expect(big.weightAfterCap).toBeCloseTo((0.35 * 1.2) / 0.65, 10);
  });

  it("withholds below minProviders", () => {
    const prices = ["a", "b", "c"].map((id) => providerPrice(id, 2.0));
    const r = computeIndex(makeInput(prices));
    expect(r.status).toBe("withheld");
    expect(r.price).not.toBeNull(); // computed but stored, never published
    expect(r.confidenceLow).toBeNull();
    expect(r.gates.find((g) => g.name === "min_providers")?.passed).toBe(false);
  });

  it("withholds below minObservations", () => {
    const prices = ["a", "b", "c", "d", "e"].map((id) =>
      providerPrice(id, 2.0, { sampleSize: 1 }),
    );
    const cfg: MethodologyConfig = {
      ...DEFAULT_METHODOLOGY_CONFIG,
      gates: { ...DEFAULT_METHODOLOGY_CONFIG.gates, minObservations: 6 },
    };
    const r = computeIndex(makeInput(prices, { config: cfg }));
    expect(r.status).toBe("withheld");
    expect(r.gates.find((g) => g.name === "min_observations")?.passed).toBe(false);
  });

  it("withholds on dispersion > max", () => {
    const prices = [1, 1, 2, 4, 8].map((p, i) => providerPrice(`p${i}`, p));
    const r = computeIndex(makeInput(prices));
    expect(r.status).toBe("withheld");
    expect(r.gates.find((g) => g.name === "max_dispersion")?.passed).toBe(false);
  });

  it("publishes degraded (not withheld) for dispersion between warn and max", () => {
    // median 3.0, MAD 0.8 → dispersion 1.4826·0.8/3.0 ≈ 0.395
    const prices = [2, 2.2, 3.0, 3.8, 4.0].map((p, i) => providerPrice(`p${i}`, p));
    const r = computeIndex(makeInput(prices));
    expect(r.status).toBe("degraded");
    expect(r.dispersion).toBeGreaterThan(DEFAULT_METHODOLOGY_CONFIG.dispersion.warn);
    expect(r.dispersion).toBeLessThanOrEqual(DEFAULT_METHODOLOGY_CONFIG.dispersion.max);
  });

  it("fails the freshness gate when a contributor's latest print is too old", () => {
    const staleTime = new Date(T0.getTime() - DEFAULT_METHODOLOGY_CONFIG.gates.maxObservationAgeMs - 1);
    const stats = new Map<string, ProviderStat>(
      ["a", "b", "c", "d"].map((id) => [
        id,
        id === "a" ? stat({ lastPriceAt: staleTime }) : stat(),
      ] as const),
    );
    const prices = ["a", "b", "c", "d"].map((id) => providerPrice(id, 2.0));
    const r = computeIndex(makeInput(prices, { stats }));
    const gate = r.gates.find((g) => g.name === "freshness");
    expect(gate?.passed).toBe(false);
    expect(r.status).toBe("withheld");
  });

  it("fails the freshness gate when a contributor has no known last print", () => {
    const stats = new Map<string, ProviderStat>(
      ["a", "b", "c", "d"].map((id) => [id, stat({ lastPriceAt: id === "a" ? null : WINDOW_END })] as const),
    );
    const prices = ["a", "b", "c", "d"].map((id) => providerPrice(id, 2.0));
    const r = computeIndex(makeInput(prices, { stats }));
    const gate = r.gates.find((g) => g.name === "freshness");
    expect(gate?.passed).toBe(false);
    expect(gate?.observed).toBeNull();
  });

  it("withholds when no contributor is executable and requireExecutable is set", () => {
    const prices = ["a", "b", "c", "d", "e"].map((id) =>
      providerPrice(id, 2.0, { executable: false }),
    );
    const r = computeIndex(makeInput(prices));
    expect(r.gates.find((g) => g.name === "require_executable")?.passed).toBe(false);
    expect(r.status).toBe("withheld");
  });

  it("carries a fresh prior forward as stale when nothing contributes", () => {
    const prior = { price: 2.12345, computedAt: new Date(T0.getTime() - 3_600_000), candidateId: "prior-1" };
    const r = computeIndex(makeInput([], { prior }));
    expect(r.status).toBe("stale");
    expect(r.price).toBe(2.1235); // round4, flagged, never fabricated silently
    expect(r.providersContributing).toBe(0);
    expect(r.calcParams.priorCandidateId).toBe("prior-1");
    expect(r.calcParams.priceSource).toBe("prior");
  });

  it("withholds when the prior is beyond the carry-forward window", () => {
    const prior = {
      price: 2.0,
      computedAt: new Date(T0.getTime() - DEFAULT_METHODOLOGY_CONFIG.stale.carryForwardWindowMs - 1),
      candidateId: "prior-2",
    };
    const r = computeIndex(makeInput([], { prior }));
    expect(r.status).toBe("withheld");
    expect(r.price).toBeNull();
  });

  it("withholds with no data at all", () => {
    const r = computeIndex(makeInput([]));
    expect(r.status).toBe("withheld");
    expect(r.price).toBeNull();
    expect(r.providersObserved).toBe(0);
  });

  it("records held-out eligible providers (thin book) as exclusions", () => {
    const prices = [
      ...["a", "b", "c", "d"].map((id) => providerPrice(id, 2.0)),
      providerPrice("thin", null, { method: "thin_book_holdout" }),
    ];
    prices[4]!.receipts.holdout = { providerId: "thin", reason: "thin_book" };
    const r = computeIndex(makeInput(prices));
    const held = r.exclusions.find((e) => e.reason === "provider_held_out");
    expect(held?.providerId).toBe("thin");
    expect(held?.detail).toContain("thin_book");
  });

  it("is deterministic: the same input yields a byte-identical receipt", () => {
    const prices = [1.98, 2.0, 2.0, 2.02, 2.04].map((p, i) => providerPrice(`p${i}`, p));
    const a = computeIndex(makeInput(prices));
    const b = computeIndex(makeInput(prices));
    expect(a.receipt).toBe(b.receipt);
    expect(a.receipt).toContain('"price":2.008');
  });
});
