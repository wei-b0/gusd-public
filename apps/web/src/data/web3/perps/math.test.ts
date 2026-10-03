/**
 * Preview-math vectors — the same doctrine vectors the keeper's math suite
 * carries (verified against the Foundry perp suite), applied to the web-side
 * subset: fees, margins, pnl, leverage, acceptable-price bounds, and the
 * liquidation-distance estimate.
 */

import { describe, expect, it } from "vitest";
import {
  acceptablePriceBound,
  feeBps,
  leverageBpsCeil,
  liquidationPriceEstimate,
  maintenance,
  mulDiv,
  pnl,
  sizeFromCollateral,
  unscalePrice,
} from "./math";

describe("mulDiv", () => {
  it("floors and ceils with dust", () => {
    expect(mulDiv(1_000n, 1n, 3n, "floor")).toBe(333n);
    expect(mulDiv(1_000n, 1n, 3n, "ceil")).toBe(334n);
    expect(mulDiv(300n, 1n, 3n, "floor")).toBe(100n);
    expect(mulDiv(300n, 1n, 3n, "ceil")).toBe(100n); // exact — no dust
  });
});

describe("fees and margins", () => {
  it("feeBps ceils", () => {
    expect(feeBps(1_000_000n, 10n)).toBe(1_000n);
    expect(feeBps(999n, 10n)).toBe(1n); // 0.999 → 1 (ledger gains the dust)
    expect(feeBps(1_000_000n, 0n)).toBe(0n);
  });

  it("maintenance ceils", () => {
    expect(maintenance(1_000_000n, 500n)).toBe(50_000n);
    expect(maintenance(1n, 500n)).toBe(1n);
  });
});

describe("pnl", () => {
  const ENTRY = 30_000n; // 3.0000 USD/GPU-hr
  it("long profit floors", () => {
    expect(pnl(1_000_000n, ENTRY, true, 33_000n)).toBe(100_000n);
  });
  it("long loss ceils", () => {
    expect(pnl(1_000_000n, ENTRY, true, 27_000n)).toBe(-100_000n);
  });
  it("short profits when price falls", () => {
    expect(pnl(1_000_000n, ENTRY, false, 27_000n)).toBe(100_000n);
  });
  it("dust rounds against the vault in both directions", () => {
    // 1_000_000 × 1 / 30_000 = 33.333… → floor 33 on profit, ceil 34 on loss.
    expect(pnl(1_000_000n, ENTRY, true, 30_001n)).toBe(33n);
    expect(pnl(1_000_000n, ENTRY, true, 29_999n)).toBe(-34n);
  });
  it("zero at flat price or zero size", () => {
    expect(pnl(1_000_000n, ENTRY, true, ENTRY)).toBe(0n);
    expect(pnl(0n, ENTRY, true, 1n)).toBe(0n);
  });
});

describe("leverage", () => {
  it("sizeFromCollateral floors", () => {
    expect(sizeFromCollateral(10_000_000n, 20_000n)).toBe(20_000_000n); // 10 gUSD × 2×
    expect(sizeFromCollateral(1n, 3n)).toBe(0n); // dust collateral → 0 notional
  });
  it("leverageBpsCeil mirrors createOrder's check", () => {
    expect(leverageBpsCeil(20_000_000n, 10_000_000n)).toBe(20_000n);
    expect(leverageBpsCeil(1n, 3n)).toBe(3_334n); // 10_000/3 → ceil
  });
});

describe("acceptablePriceBound", () => {
  const PRICE = 30_000n; // 3.0000 USD/GPU-hr
  const TOL = 50n; // 0.5%
  it("longs buy with an upper bound (ceil)", () => {
    expect(acceptablePriceBound(PRICE, TOL, true, true)).toBe(30_150n);
  });
  it("shorts sell with a lower bound (floor)", () => {
    expect(acceptablePriceBound(PRICE, TOL, false, true)).toBe(29_850n);
  });
  it("longs close with a lower bound (floor)", () => {
    expect(acceptablePriceBound(PRICE, TOL, true, false)).toBe(29_850n);
  });
  it("shorts close with an upper bound (ceil)", () => {
    expect(acceptablePriceBound(PRICE, TOL, false, false)).toBe(30_150n);
  });
  it("zero tolerance pins the reference price", () => {
    expect(acceptablePriceBound(PRICE, 0n, true, true)).toBe(PRICE);
    expect(acceptablePriceBound(PRICE, 0n, false, false)).toBe(PRICE);
  });
  it("never returns zero on a dust price", () => {
    expect(acceptablePriceBound(1n, 9_999n, false, true)).toBe(1n);
  });
});

describe("liquidationPriceEstimate", () => {
  const ENTRY = 30_000n; // 3.0000 USD/GPU-hr
  it("long: boundary below entry at maintenance distance", () => {
    // 200 gUSD notional, 20 gUSD collateral, 5% mm → maint 10 gUSD; headroom
    // 10 gUSD = 5% of notional → 3.0 × 0.95 = 2.85.
    expect(liquidationPriceEstimate(200_000_000n, 20_000_000n, ENTRY, true, 500n, 0n)).toBe(28_500n);
  });
  it("short: boundary above entry", () => {
    expect(liquidationPriceEstimate(200_000_000n, 20_000_000n, ENTRY, false, 500n, 0n)).toBe(31_500n);
  });
  it("funding debt narrows the distance", () => {
    // headroom 20 − 10 − 2 = 8 gUSD = 4% of notional → 2.88.
    expect(liquidationPriceEstimate(200_000_000n, 20_000_000n, ENTRY, true, 500n, 2_000_000n)).toBe(28_800n);
  });
  it("nulls without a maintenance floor or a position", () => {
    expect(liquidationPriceEstimate(200_000_000n, 20_000_000n, ENTRY, true, 0n, 0n)).toBeNull();
    expect(liquidationPriceEstimate(0n, 20_000_000n, ENTRY, true, 500n, 0n)).toBeNull();
  });
  it("clamps at zero once underwater past recovery", () => {
    // Collateral below maintenance: headroom negative — boundary above entry.
    const est = liquidationPriceEstimate(200_000_000n, 5_000_000n, ENTRY, true, 500n, 0n);
    expect(est).not.toBeNull();
    expect(est as bigint).toBeGreaterThan(ENTRY);
  });
});

describe("unscalePrice", () => {
  it("inverts the attestor's ×10_000 scaling", () => {
    expect(unscalePrice(30_000n)).toBe(3);
    expect(unscalePrice(29_850n)).toBe(2.985);
  });
});