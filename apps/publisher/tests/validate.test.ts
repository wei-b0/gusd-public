import { describe, expect, it } from "vitest";
import { validateCandidate } from "../src/validate.js";
import { VIOLATION, type CandidateLike, type ResolvedPublisherConfig } from "../src/types.js";

const NOW = new Date("2026-09-04T12:00:00.000Z");

const CONFIG: ResolvedPublisherConfig = {
  pinnedMethodologyVersion: "0.1.0",
  minContributors: 3,
  maxDispersion: 0.45,
  maxFreshnessMs: 300_000,
  maxJumpPct: 0.25,
  maxBandWidthPct: 0.1,
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

describe("validateCandidate", () => {
  it("accepts a healthy candidate and emits the publishable value", () => {
    const result = validateCandidate(healthy(), {
      config: CONFIG,
      now: NOW,
      previousPublishedPrice: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.price).toBe(2.94);
    expect(result.value.candidateId).toBe("c1");
    expect(result.value.computedAt).toBe("2026-09-04T11:59:50.000Z");
  });

  it("refuses withheld and stale statuses", () => {
    for (const status of ["withheld", "stale", "frozen"] as const) {
      const result = validateCandidate(healthy({ status }), {
        config: CONFIG,
        now: NOW,
        previousPublishedPrice: null,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.violations.map((v) => v.code)).toContain(VIOLATION.status);
    }
  });

  it("refuses a candidate older than the freshness window", () => {
    const old = healthy({
      computedAt: new Date(NOW.getTime() - CONFIG.maxFreshnessMs - 1),
    });
    const result = validateCandidate(old, {
      config: CONFIG,
      now: NOW,
      previousPublishedPrice: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.code)).toContain(VIOLATION.freshness);
  });

  it("refuses a methodology version other than the pin", () => {
    const result = validateCandidate(healthy({ methodologyVersion: "0.2.0" }), {
      config: CONFIG,
      now: NOW,
      previousPublishedPrice: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.code)).toContain(VIOLATION.methodology);
  });

  it("refuses too few contributors", () => {
    const result = validateCandidate(healthy({ providersContributing: 2 }), {
      config: CONFIG,
      now: NOW,
      previousPublishedPrice: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.code)).toContain(VIOLATION.contributors);
  });

  it("refuses dispersion above the cap", () => {
    const result = validateCandidate(healthy({ dispersion: 0.5 }), {
      config: CONFIG,
      now: NOW,
      previousPublishedPrice: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.code)).toContain(VIOLATION.dispersion);
  });

  it("refuses a confidence band wider than the price fraction cap", () => {
    // band width 0.5 on price 2.94 ≈ 17% > 10%.
    const result = validateCandidate(
      healthy({ confidenceLow: 2.69, confidenceHigh: 3.19 }),
      { config: CONFIG, now: NOW, previousPublishedPrice: null },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.code)).toContain(VIOLATION.band);
  });

  it("rejects a price jump beyond the cap against the last published value", () => {
    // previous 2.00 → candidate 2.94: +47%.
    const result = validateCandidate(healthy(), {
      config: CONFIG,
      now: NOW,
      previousPublishedPrice: 2.0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.code)).toContain(VIOLATION.jump);
  });

  it("allows a jump exactly at the cap (violation is strictly greater)", () => {
    // previous 2.00, candidate 2.50 → exactly +25%.
    const result = validateCandidate(healthy({ price: 2.5 }), {
      config: CONFIG,
      now: NOW,
      previousPublishedPrice: 2.0,
    });
    expect(result.ok).toBe(true);
  });

  it("skips the jump check on first publication", () => {
    const result = validateCandidate(healthy(), {
      config: CONFIG,
      now: NOW,
      previousPublishedPrice: null,
    });
    expect(result.ok).toBe(true);
  });

  it("refuses when a majority of contributing providers have open breakers", () => {
    const breakers = new Map<string, boolean>([
      ["vast", true],
      ["lium", true],
      ["hyperbolic", true],
      ["runpod", false],
    ]);
    const result = validateCandidate(healthy(), {
      config: CONFIG,
      now: NOW,
      previousPublishedPrice: null,
      breakers,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.code)).toContain(VIOLATION.sources);
  });

  it("allows when only a minority of breakers are open", () => {
    const breakers = new Map<string, boolean>([
      ["vast", true],
      ["lium", false],
      ["hyperbolic", false],
      ["runpod", false],
    ]);
    const result = validateCandidate(healthy(), {
      config: CONFIG,
      now: NOW,
      previousPublishedPrice: null,
      breakers,
    });
    expect(result.ok).toBe(true);
  });

  it("accumulates every violation, not just the first", () => {
    const result = validateCandidate(
      healthy({
        status: "withheld",
        price: null,
        methodologyVersion: "0.2.0",
        providersContributing: 1,
        dispersion: 0.9,
      }),
      { config: CONFIG, now: NOW, previousPublishedPrice: 2.0 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
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
  });

  it("ignores unknown providers in the breaker map (only known-open counts)", () => {
    const breakers = new Map<string, boolean>([["someone-else", true]]);
    const result = validateCandidate(healthy(), {
      config: CONFIG,
      now: NOW,
      previousPublishedPrice: null,
      breakers,
    });
    expect(result.ok).toBe(true);
  });
});
