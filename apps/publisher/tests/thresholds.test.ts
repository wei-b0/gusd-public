import { describe, expect, it } from "vitest";
import { DEFAULT_METHODOLOGY_CONFIG } from "@gusd/pricing-engine";
import { resolvePanelThresholds } from "../src/thresholds.js";
import type { PublisherConfig } from "../src/types.js";

const BASE: PublisherConfig = {
  pinnedMethodologyVersion: "0.2.0",
  minContributors: null,
  maxDispersion: null,
  maxFreshnessMs: 300_000,
  maxJumpPct: 0.25,
  maxBandWidthPct: null,
  minDeviationPct: 0.5,
  heartbeatMs: 86_400_000,
};

describe("resolvePanelThresholds", () => {
  it("a flagship panel inherits the methodology's own quorum and caps", () => {
    const t = resolvePanelThresholds(BASE, DEFAULT_METHODOLOGY_CONFIG, "H100_PANEL_V1");
    expect(t.minContributors).toBe(4);
    expect(t.maxDispersion).toBe(0.45);
    expect(t.maxBandWidthPct).toBe(0.45);
    expect(t.maxFreshnessMs).toBe(300_000);
  });

  it("a thin panel publishes on its per-panel quorum and dispersion cap", () => {
    const gb200 = resolvePanelThresholds(BASE, DEFAULT_METHODOLOGY_CONFIG, "GB200_PANEL_V1");
    expect(gb200.minContributors).toBe(1);
    expect(gb200.maxDispersion).toBe(0.45);

    const gb300 = resolvePanelThresholds(BASE, DEFAULT_METHODOLOGY_CONFIG, "GB300_PANEL_V1");
    expect(gb300.minContributors).toBe(2);
    expect(gb300.maxDispersion).toBe(0.9);
    expect(gb300.maxBandWidthPct).toBe(0.9);
  });

  it("an explicit env floor tightens but never relaxes the panel quorum", () => {
    const t = resolvePanelThresholds(
      { ...BASE, minContributors: 3 },
      DEFAULT_METHODOLOGY_CONFIG,
      "GB200_PANEL_V1",
    );
    expect(t.minContributors).toBe(3);
  });

  it("an explicit env ceiling tightens but never relaxes the panel dispersion cap", () => {
    const t = resolvePanelThresholds(
      { ...BASE, maxDispersion: 0.3, maxBandWidthPct: 0.2 },
      DEFAULT_METHODOLOGY_CONFIG,
      "GB300_PANEL_V1",
    );
    expect(t.maxDispersion).toBe(0.3);
    expect(t.maxBandWidthPct).toBe(0.2);
  });
});
