import { describe, expect, it } from "vitest";
import { DEFAULT_METHODOLOGY_CONFIG } from "@gusd/pricing-engine";
import { resolvePanelThresholds } from "../src/thresholds.js";
import type { AttestorConfig } from "../src/types.js";

const BASE: AttestorConfig = {
  pinnedMethodologyVersion: "0.2.0",
  minContributors: null,
  maxDispersion: null,
  maxFreshnessMs: 300_000,
  maxJumpPct: 0.25,
  maxBandWidthPct: null,
};

describe("resolvePanelThresholds", () => {
  it("a flagship panel inherits the methodology's own quorum and caps", () => {
    // H200 has no override — the untouched global quorum.
    const h200 = resolvePanelThresholds(BASE, DEFAULT_METHODOLOGY_CONFIG, "H200_PANEL_V1");
    expect(h200.minContributors).toBe(4);
    expect(h200.maxDispersion).toBe(0.45);
    expect(h200.maxBandWidthPct).toBe(0.45);
    expect(h200.maxFreshnessMs).toBe(300_000);

    // v0.5.1: H100's reduced quorum (3, executable floor kept) is what the
    // audit follows — the attestor audits the same gates the engine ran.
    const t = resolvePanelThresholds(BASE, DEFAULT_METHODOLOGY_CONFIG, "H100_PANEL_V1");
    expect(t.minContributors).toBe(3);
    expect(t.maxDispersion).toBe(0.45);
    expect(t.maxBandWidthPct).toBe(0.45);
    expect(t.maxFreshnessMs).toBe(300_000);
  });

  it("a thin panel attests on its per-panel quorum and dispersion cap", () => {
    const l40s = resolvePanelThresholds(BASE, DEFAULT_METHODOLOGY_CONFIG, "L40S_PANEL_V1");
    expect(l40s.minContributors).toBe(3);
    expect(l40s.maxDispersion).toBe(0.45);

    const rtx4090 = resolvePanelThresholds(BASE, DEFAULT_METHODOLOGY_CONFIG, "RTX_4090_PANEL_V1");
    expect(rtx4090.minContributors).toBe(3);
    expect(rtx4090.maxDispersion).toBe(0.45);
    expect(rtx4090.maxBandWidthPct).toBe(0.45);
  });

  it("an explicit env floor tightens but never relaxes the panel quorum", () => {
    const t = resolvePanelThresholds(
      { ...BASE, minContributors: 4 },
      DEFAULT_METHODOLOGY_CONFIG,
      "L40S_PANEL_V1",
    );
    expect(t.minContributors).toBe(4);
  });

  it("an explicit env ceiling tightens but never relaxes the panel dispersion cap", () => {
    const t = resolvePanelThresholds(
      { ...BASE, maxDispersion: 0.3, maxBandWidthPct: 0.2 },
      DEFAULT_METHODOLOGY_CONFIG,
      "RTX_4090_PANEL_V1",
    );
    expect(t.maxDispersion).toBe(0.3);
    expect(t.maxBandWidthPct).toBe(0.2);
  });
});
