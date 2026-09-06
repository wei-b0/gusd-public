import { describe, expect, it } from "vitest";
import {
  applyBps,
  formatGpuUnits,
  formatGusdRaw,
  parseGpuUnits,
  parseGusd,
} from "./units";

describe("units", () => {
  it("parses gUSD at 6 decimals and formats back", () => {
    expect(parseGusd(2.5).toString()).toBe("2500000");
    expect(parseGusd(0).toString()).toBe("0");
    expect(formatGusdRaw(2_500_000n)).toBe(2.5);
  });

  it("parses GPU sizes at 18 decimals and formats back", () => {
    expect(parseGpuUnits(1).toString()).toBe("1000000000000000000");
    expect(formatGpuUnits(parseGpuUnits(2.5))).toBe(2.5);
  });

  it("never produces negative or NaN raw values", () => {
    expect(parseGusd(Number.NaN).toString()).toBe("0");
    expect(parseGusd(-3).toString()).toBe("0");
  });

  it("applies bps upward with a ceiling (spend caps)", () => {
    // 1_000_000 raw (+50bps) = 1_005_000 exactly.
    expect(applyBps(1_000_000n, 50, "up")).toBe(1_005_000n);
    // 333_333 × 1.005 = 334_999.665 → ceiling 335_000: never below the cap.
    expect(applyBps(333_333n, 50, "up")).toBe(335_000n);
  });

  it("applies bps downward with a floor (minimums)", () => {
    expect(applyBps(1_000_000n, 50, "down")).toBe(995_000n);
    expect(applyBps(333_333n, 50, "down")).toBe(331_666n);
  });

  it("tolerance of zero bps is identity", () => {
    expect(applyBps(7n, 0, "up")).toBe(7n);
    expect(applyBps(7n, 0, "down")).toBe(7n);
  });
});
