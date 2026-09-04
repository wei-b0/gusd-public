import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ProviderPriceResult, ProviderRole } from "@gusd/types";
import { CATALOG } from "@gusd/gpu-catalog";
import {
  DEFAULT_METHODOLOGY_CONFIG,
  computeIndex,
  madScreen,
  aggregateProviderPrice,
  type AggregationObservation,
  type IndexInput,
  type ProviderStat,
} from "../src/index.js";

const GPU = CATALOG.find((g) => g.id === "H100_SXM_80GB")!;
const T0 = new Date("2026-09-04T00:00:00.000Z");

/** Cent-grid prices: exact ties (and therefore MAD = 0) are reachable. */
const centPrice = fc.integer({ min: 5, max: 2000 }).map((c) => c / 100);

let seq = 0;
function providerPrice(
  price: number,
  opts: { executable?: boolean; sampleSize?: number } = {},
): ProviderPriceResult {
  seq += 1;
  return {
    providerId: `p${seq}`,
    gpuId: GPU.id,
    panelId: "H100_PANEL_V1",
    price,
    executable: opts.executable ?? true,
    method: "median",
    sampleSize: opts.sampleSize ?? 3,
    windowStart: new Date(T0.getTime() - 30 * 60_000),
    windowEnd: T0,
    computedAt: T0,
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

function makeInput(
  prices: ProviderPriceResult[],
  overrides: Partial<Pick<IndexInput, "config">> = {},
): IndexInput {
  const stats = new Map<string, ProviderStat>(
    prices.map((p) => [
      p.providerId,
      { sigma: 0.02, lastPriceAt: T0, trailingMedian: null },
    ] as const),
  );
  const roleMap = new Map<string, ProviderRole>(
    prices.map((p) => [p.providerId, "SETTLEMENT_ELIGIBLE" as const]),
  );
  return {
    gpu: GPU,
    panelId: "H100_PANEL_V1",
    providerPrices: prices,
    providerRoles: roleMap,
    providerStats: stats,
    prior: null,
    now: T0,
    windowStart: new Date(T0.getTime() - 30 * 60_000),
    windowEnd: T0,
    config: overrides.config ?? DEFAULT_METHODOLOGY_CONFIG,
  };
}

const providerSet = (min: number, max: number) =>
  fc.array(centPrice, { minLength: min, maxLength: max }).map((ps) => ps.map((p) => providerPrice(p)));

describe("pricing-engine properties", () => {
  it("P1 containment: a computed price lies within the min/max of its contributors", () => {
    fc.assert(
      fc.property(providerSet(4, 9), (prices) => {
        const r = computeIndex(makeInput(prices));
        if (r.status !== "healthy" && r.status !== "degraded") return;
        const values = r.contributors.map((c) => c.price);
        expect(r.price).toBeGreaterThanOrEqual(Math.min(...values) - 1e-9);
        expect(r.price).toBeLessThanOrEqual(Math.max(...values) + 1e-9);
      }),
      { numRuns: 300 },
    );
  });

  it("P2 absurd high prices are always screened, whatever the rest of the book looks like", () => {
    // Absurd LOWS are the plausible band's job (aggregation-time):
    // near a $0.50 median, a σ screen with MAD 0.25 legitimately tolerates
    // $0.0001 — the engine-level invariant is the high side.
    const bookArb = fc
      .array(fc.integer({ min: 50, max: 500 }), { minLength: 4, maxLength: 8 })
      .map((cents) => [...cents.map((c) => providerPrice(c / 100)), providerPrice(1_000_000)]);
    fc.assert(
      fc.property(bookArb, (prices) => {
        const r = computeIndex(makeInput(prices));
        const absurdId = prices[prices.length - 1]!.providerId;
        expect(
          r.exclusions.some((e) => e.providerId === absurdId),
          `absurd price survived: ${r.exclusions.map((e) => `${e.providerId}:${e.reason}`).join(", ")}`,
        ).toBe(true);
        expect(r.contributors.some((c) => c.providerId === absurdId)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it("P3 flooding invariance: extra rows at the same level cannot move a rate-card median", () => {
    const base = fc.integer({ min: 50, max: 500 }).map((c) => c / 100);
    fc.assert(
      fc.property(base, fc.integer({ min: 2, max: 40 }), (level, floodCount) => {
        const row = (i: number, price: number): AggregationObservation => ({
          offerId: `o${i}`,
          machineId: null,
          hostId: null,
          usdPerGpuHour: price,
          rawTotalUsdPerHour: null,
          pricingTier: "on_demand",
          gpuCount: null,
          isBid: false,
          available: true,
          region: null,
          observedAt: T0,
        });
        const rows = [
          ...Array.from({ length: floodCount }, (_, i) => row(i, level)),
          row(999, level * 10),
        ];
        const r = aggregateProviderPrice({
          providerId: "flooded",
          gpu: GPU,
          panelId: "H100_PANEL_V1",
          observations: rows,
          executable: false,
          coverageGap: false,
          config: DEFAULT_METHODOLOGY_CONFIG.aggregation,
          windowStart: T0,
          windowEnd: T0,
          computedAt: T0,
          methodologyVersion: DEFAULT_METHODOLOGY_CONFIG.version,
        });
        expect(r.price).toBe(level);
      }),
      { numRuns: 200 },
    );
  });

  it("P4 scale invariance: multiplying every price by k multiplies the index by k", () => {
    const kArb = fc.integer({ min: 2, max: 5000 });
    fc.assert(
      fc.property(providerSet(4, 8), kArb, (prices, k) => {
        const base = computeIndex(makeInput(prices));
        const scaled = computeIndex(makeInput(prices.map((p) => providerPrice(p.price! * k))));
        // dispersion is a ratio — invariant up to floating-point noise
        expect(Math.abs(scaled.dispersion - base.dispersion)).toBeLessThanOrEqual(1e-9);
        expect(base.status).toBe(scaled.status);
        if (base.price === null) {
          expect(scaled.price).toBeNull();
          return;
        }
        const tol = (k + 1) * 6e-5; // both sides are round4'd
        expect(Math.abs((scaled.price ?? 0) - base.price * k)).toBeLessThanOrEqual(tol);
        if (base.confidenceLow !== null && scaled.confidenceLow !== null) {
          expect(Math.abs(scaled.confidenceLow - base.confidenceLow * k)).toBeLessThanOrEqual(tol);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("P5 order irrelevance: shuffling equal-weight providers cannot change the result", () => {
    fc.assert(
      fc.property(
        fc.array(centPrice, { minLength: 4, maxLength: 9 }),
        fc.integer({ min: 1, max: 9 }),
        (prices, seed) => {
          // All-executable → equal weights → the cap can never fire.
          const a = computeIndex(makeInput(prices.map((p) => providerPrice(p))));
          const shuffled = [...prices];
          // deterministic Fisher-Yates with the fast-check seed
          let s = seed * 7919 + 13;
          for (let i = shuffled.length - 1; i > 0; i--) {
            s = (s * 1103515245 + 12345) % 2147483648;
            const j = s % (i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
          }
          const b = computeIndex(makeInput(shuffled.map((p) => providerPrice(p))));
          expect(b.status).toBe(a.status);
          expect(b.dispersion).toBeCloseTo(a.dispersion, 12);
          // Compare pre-rounding means: the two summation orders are equal up
          // to float noise, but a round4 boundary can flip on that noise.
          const mean = (r: typeof a): number | null => {
            if (r.contributors.length === 0) return null;
            const total = r.contributors.reduce((s, c) => s + c.weightAfterCap, 0);
            return r.contributors.reduce((s, c) => s + c.price * c.weightAfterCap, 0) / total;
          };
          const ma = mean(a);
          const mb = mean(b);
          if (ma === null) expect(mb).toBeNull();
          else expect(mb).toBeCloseTo(ma, 9);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("P6 the weight cap holds: no provider exceeds cap × total after capping", () => {
    // minLength 3: with two providers the cap is mathematically infeasible
    // (someone always holds ≥ 50%), and capWeights then leaves weights
    // undistorted — the min_providers gate blocks such books from publishing.
    const flagsArb = fc.array(fc.boolean(), { minLength: 3, maxLength: 9 });
    fc.assert(
      fc.property(flagsArb, centPrice, (flags, level) => {
        const prices = flags.map((exec) => providerPrice(level, { executable: exec }));
        const r = computeIndex(makeInput(prices));
        const total = r.contributors.reduce((a, c) => a + c.weightAfterCap, 0);
        for (const c of r.contributors) {
          expect(c.weightAfterCap / total).toBeLessThanOrEqual(
            DEFAULT_METHODOLOGY_CONFIG.weightCap + 1e-9,
          );
        }
      }),
      { numRuns: 300 },
    );
  });

  it("P7 a failed gate always blocks publication status", () => {
    fc.assert(
      fc.property(providerSet(1, 9), (prices) => {
        const r = computeIndex(makeInput(prices));
        if (r.status === "healthy" || r.status === "degraded") {
          expect(r.gates.every((g) => g.passed)).toBe(true);
          expect(r.providersContributing).toBeGreaterThanOrEqual(
            DEFAULT_METHODOLOGY_CONFIG.gates.minProviders,
          );
        } else if (r.status === "withheld" && r.providersContributing > 0) {
          expect(r.gates.some((g) => !g.passed)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("P8 dispersion is always defined and non-negative", () => {
    fc.assert(
      fc.property(providerSet(0, 9), (prices) => {
        const r = computeIndex(makeInput(prices));
        expect(r.dispersion).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(r.dispersion)).toBe(true);
        if (r.price !== null) expect(Number.isFinite(r.price)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("P9 screening monotonicity: the screen never keeps a price farther out than one it excluded", () => {
    fc.assert(
      fc.property(fc.array(centPrice, { minLength: 4, maxLength: 12 }), (prices) => {
        const res = madScreen(
          prices.map((p, i) => ({ providerId: `p${i}`, price: p })),
          DEFAULT_METHODOLOGY_CONFIG.screening,
        );
        if (res.exclusions.length === 0 || res.kept.length === 0) return;
        // Exclusions are decided against the pre-screen median; monotonicity
        // means every kept price is at least as close to it as every excluded
        // one — for both the MAD>0 σ path and the MAD=0 ratio-band path.
        const sorted = [...prices].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const preMedian =
          sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
        const keptDist = Math.max(...res.kept.map((k) => Math.abs(k.price - preMedian)));
        const exclDist = Math.min(
          ...res.exclusions.map((e) => Math.abs((e.value ?? preMedian) - preMedian)),
        );
        expect(keptDist).toBeLessThanOrEqual(exclDist + 1e-9);
      }),
      { numRuns: 300 },
    );
  });
});
