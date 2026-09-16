import { describe, expect, it } from "vitest";
import { assessCandidate } from "../src/validate.js";
import { VIOLATION, type CandidateLike, type ResolvedPublisherConfig } from "../src/types.js";

const NOW = new Date("2026-09-04T12:00:00.000Z");

const CONFIG: ResolvedPublisherConfig = {
  pinnedMethodologyVersion: "0.1.0",
  minContributors: 3,
  maxDispersion: 0.45,
  maxFreshnessMs: 300_000,
  maxJumpPct: 0.25,
  maxBandWidthPct: 0.1,
  minDeviationPct: 0.5,
  heartbeatMs: 86_400_000,
};

/** A candidate that passes every check — individual tests knock one leg out. */
function healthy(overrides: Partial<CandidateLike> = {}): CandidateLike {
  return {
    id: "c1",
    gpuId: "H100_SXM_80GB",
    panelId: "H100_PANEL_V1",
    price: 2.94,
    confidenceLow: 2.86,
    confidenceHigh: 3.02,
    status: "healthy",
    providersContributing: 4,
    dispersion: 0.02,
    methodologyVersion: "0.1.0",
    calcHash: "abc",
    computedAt: new Date(NOW.getTime() - 10_000),
    contributors: [
      { providerId: "vast" },
      { providerId: "lium" },
      { providerId: "hyperbolic" },
      { providerId: "runpod" },
    ],
    ...overrides,
  };
}

function assess(overrides: Partial<CandidateLike> = {}, previousPublishedPrice: number | null = null) {
  return assessCandidate(healthy(overrides), {
    config: CONFIG,
    now: NOW,
    previousPublishedPrice,
  });
}

describe("assessCandidate", () => {
  it("assesses a clean candidate: no violations, publishable value", () => {
    const result = assess();
    expect(result.violations).toEqual([]);
    expect(result.value?.price).toBe(2.94);
    expect(result.value?.candidateId).toBe("c1");
    expect(result.value?.computedAt).toBe("2026-09-04T11:59:50.000Z");
  });

  it("annotates — but never blocks — withheld and stale statuses", () => {
    for (const status of ["withheld", "stale", "frozen"] as const) {
      const result = assess({ status });
      expect(result.violations.map((v) => v.code)).toContain(VIOLATION.status);
      expect(result.value).not.toBeNull();
      expect(result.value?.status).toBe(status);
    }
  });

  it("annotates a candidate older than the freshness window", () => {
    const result = assess({ computedAt: new Date(NOW.getTime() - CONFIG.maxFreshnessMs - 1) });
    expect(result.violations.map((v) => v.code)).toContain(VIOLATION.freshness);
    expect(result.value).not.toBeNull();
  });

  it("annotates a methodology version other than the pin", () => {
    const result = assess({ methodologyVersion: "0.2.0" });
    expect(result.violations.map((v) => v.code)).toContain(VIOLATION.methodology);
    expect(result.value).not.toBeNull();
  });

  it("annotates too few contributors", () => {
    const result = assess({ providersContributing: 2 });
    expect(result.violations.map((v) => v.code)).toContain(VIOLATION.contributors);
    expect(result.value).not.toBeNull();
  });

  it("annotates dispersion above the cap", () => {
    const result = assess({ dispersion: 0.5 });
    expect(result.violations.map((v) => v.code)).toContain(VIOLATION.dispersion);
    expect(result.value).not.toBeNull();
  });

  it("annotates a confidence band wider than the price fraction cap", () => {
    // band width 0.5 on price 2.94 ≈ 17% > 10%.
    const result = assess({ confidenceLow: 2.69, confidenceHigh: 3.19 });
    expect(result.violations.map((v) => v.code)).toContain(VIOLATION.band);
    expect(result.value).not.toBeNull();
  });

  it("annotates a price jump beyond the cap against the last published value", () => {
    // previous 2.00 → candidate 2.94: +47%.
    const result = assess({}, 2.0);
    expect(result.violations.map((v) => v.code)).toContain(VIOLATION.jump);
    expect(result.value).not.toBeNull();
  });

  it("stays quiet for a move exactly at the cap (violation is strictly greater)", () => {
    // previous 2.00, candidate 2.50 → exactly +25%.
    const result = assess({ price: 2.5 }, 2.0);
    expect(result.violations).toEqual([]);
  });

  it("skips the jump check on first publication", () => {
    expect(assess().violations).toEqual([]);
  });

  it("annotates when a majority of contributing providers have open breakers", () => {
    const breakers = new Map<string, boolean>([
      ["vast", true],
      ["lium", true],
      ["hyperbolic", true],
      ["runpod", false],
    ]);
    const result = assessCandidate(healthy(), {
      config: CONFIG,
      now: NOW,
      previousPublishedPrice: null,
      breakers,
    });
    expect(result.violations.map((v) => v.code)).toContain(VIOLATION.sources);
    expect(result.value).not.toBeNull();
  });

  it("stays quiet when only a minority of breakers are open", () => {
    const breakers = new Map<string, boolean>([
      ["vast", true],
      ["lium", false],
      ["hyperbolic", false],
      ["runpod", false],
    ]);
    const result = assessCandidate(healthy(), {
      config: CONFIG,
      now: NOW,
      previousPublishedPrice: null,
      breakers,
    });
    expect(result.violations).toEqual([]);
  });

  it("carries no publishable value when the candidate has no price", () => {
    const result = assess({ price: null, confidenceLow: null, confidenceHigh: null });
    expect(result.value).toBeNull();
    expect(result.violations.map((v) => v.code)).toContain(VIOLATION.price);
  });

  it("accumulates every violation, not just the first", () => {
    const result = assess(
      {
        status: "withheld",
        price: null,
        confidenceLow: null,
        confidenceHigh: null,
        methodologyVersion: "0.2.0",
        providersContributing: 1,
        dispersion: 0.9,
      },
      2.0,
    );
    const codes = result.violations.map((v) => v.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        VIOLATION.status,
        VIOLATION.price,
        VIOLATION.methodology,
        VIOLATION.contributors,
        VIOLATION.dispersion,
      ]),
    );
    expect(result.value).toBeNull();
  });

  it("ignores unknown providers in the breaker map (only known-open counts)", () => {
    const breakers = new Map<string, boolean>([["someone-else", true]]);
    const result = assessCandidate(healthy(), {
      config: CONFIG,
      now: NOW,
      previousPublishedPrice: null,
      breakers,
    });
    expect(result.violations).toEqual([]);
  });
});
