/**
 * The offline math must match the engine bit-for-bit in rounding direction —
 * every vector here mirrors what the Foundry suites assert on the Solidity
 * side (see apps/contracts/test/unit/PerpFunding.t.sol). A drifted replica
 * means missed liquidations or burned-gas reverts.
 */
import { describe, expect, it } from "vitest";
import {
  advanceFunding,
  acceptablePriceMet,
  borrowDrift,
  equity,
  feeBps,
  fundingDrift,
  fundingEarned,
  fundingOwed,
  isLiquidatable,
  maintenance,
  pnl,
  scalePrice,
  settle,
  skewFraction,
  triggerMet,
  type MarketFunding,
} from "../math.js";

describe("fees and margins", () => {
  it("feeBps ceils", () => {
    expect(feeBps(1_000_000n, 10n)).toBe(1_000n);
    expect(feeBps(999_999n, 10n)).toBe(1_000n); // 999.999 → 1000
    expect(feeBps(1n, 10n)).toBe(1n);
    expect(feeBps(0n, 10n)).toBe(0n);
  });

  it("maintenance ceils", () => {
    expect(maintenance(10_000n, 500n)).toBe(500n);
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

describe("funding deltas", () => {
  it("owed ceils, earned floors", () => {
    const delta = 333_333_333_333_333_333n; // 1/3 WAD
    expect(fundingOwed(1_000_000n, delta, 0n)).toBe(333_334n);
    expect(fundingEarned(1_000_000n, delta, 0n)).toBe(333_333n);
    expect(fundingOwed(1_000_000n, 0n, 5n)).toBe(0n); // cum <= checkpoint
  });
});

describe("skew + drift", () => {
  it("skewFraction is |L−S|/total as WAD", () => {
    expect(skewFraction(8_000_000n, 2_000_000n)).toBe(600_000_000_000_000_000n);
    expect(skewFraction(2_000_000n, 8_000_000n)).toBe(600_000_000_000_000_000n);
    expect(skewFraction(0n, 0n)).toBe(0n);
    expect(skewFraction(5_000_000n, 5_000_000n)).toBe(0n);
  });
  it("fundingDrift is one floor mulDiv", () => {
    // 1000 ppm × 60s × 0.5e18 skew / 1e6
    expect(fundingDrift(1_000n, 60n, 500_000_000_000_000_000n)).toBe(30_000_000_000_000_000n);
  });
  it("borrowDrift ceils", () => {
    expect(borrowDrift(2n, 10n)).toBe(20_000_000_000_000n);
  });
});

describe("advanceFunding (PerpFunding.accrue, offline)", () => {
  const base: MarketFunding = {
    openNotionalLong: 8_000_000n,
    openNotionalShort: 2_000_000n,
    fundingChargePerUnitLong: 0n,
    fundingChargePerUnitShort: 0n,
    fundingCreditPerUnitLong: 0n,
    fundingCreditPerUnitShort: 0n,
    borrowChargePerUnit: 0n,
    fundingUpdatedAtSec: 1_000n,
    fundingRatePpmPerSec: 1_000n,
    borrowRatePpmPerSec: 10n,
  };

  it("longs pay shorts, conserved pro-rata", () => {
    const adv = advanceFunding(base, 1_060n); // window 60, skew 0.6e18
    // drift = 1000 × 60 × 0.6e18 / 1e6 = 3.6e16
    expect(adv.fundingChargePerUnitLong).toBe(36_000_000_000_000_000n);
    // credit = drift × 8/2 = 1.44e17
    expect(adv.fundingCreditPerUnitShort).toBe(144_000_000_000_000_000n);
    // Total charged = 3.6e16 × 8e6/1e18 = 0.288; credited = 1.44e17 × 2e6/1e18 = 0.288.
    expect(adv.fundingCreditPerUnitLong).toBe(0n);
    expect(adv.borrowChargePerUnit).toBe(10n * 60n * 10n ** 18n / 1_000_000n); // 6e14
  });

  it("shorts pay longs when shorts dominate", () => {
    const adv = advanceFunding({ ...base, openNotionalLong: 2_000_000n, openNotionalShort: 8_000_000n }, 1_060n);
    expect(adv.fundingChargePerUnitShort).toBe(36_000_000_000_000_000n);
    expect(adv.fundingCreditPerUnitLong).toBe(144_000_000_000_000_000n);
    expect(adv.fundingChargePerUnitLong).toBe(0n);
  });

  it("clamps one window at 3600s (one accrual call = one clamp)", () => {
    const adv = advanceFunding(base, 1_000n + 7_200n);
    expect(adv.windowSec).toBe(3_600n);
    // Borrow half of the 7200s drift: 10 × 3600 × 1e18 / 1e6 = 3.6e16.
    expect(adv.borrowChargePerUnit).toBe(36_000_000_000_000_000n);
  });

  it("is a no-op at or before fundingUpdatedAtSec", () => {
    const adv = advanceFunding(base, 1_000n);
    expect(adv.windowSec).toBe(0n);
    expect(adv.borrowChargePerUnit).toBe(0n);
  });
});

describe("liquidation gate", () => {
  const mkMarket = (over: Partial<MarketFunding> = {}): MarketFunding => ({
    openNotionalLong: 1_000_000n,
    openNotionalShort: 0n,
    fundingChargePerUnitLong: 0n,
    fundingChargePerUnitShort: 0n,
    fundingCreditPerUnitLong: 0n,
    fundingCreditPerUnitShort: 0n,
    borrowChargePerUnit: 0n,
    fundingUpdatedAtSec: 0n,
    fundingRatePpmPerSec: 0n,
    borrowRatePpmPerSec: 0n,
    ...over,
  });

  it("underwater position liquidates", () => {
    const pos = {
      sizeUsd: 1_000_000n,
      collateral: 50_000n,
      entryPrice: 30_000n,
      fundingFeeCheckpoint: 0n,
      fundingCreditCheckpoint: 0n,
      borrowCheckpoint: 0n,
      isLong: true,
    };
    const adv = advanceFunding(mkMarket(), 1n);
    const s = settle(mkMarket(), adv, pos);
    // price 27_000 → uPnL −100_000 → equity −50_000 < maintenance 50_000.
    expect(isLiquidatable(pos, s, 27_000n, 500n)).toBe(true);
    // healthy: collateral 500_000 → equity 400_000.
    expect(isLiquidatable({ ...pos, collateral: 500_000n }, s, 27_000n, 500n)).toBe(false);
    // boundary: equity exactly at maintenance → NOT liquidatable (strict <).
    expect(isLiquidatable({ ...pos, collateral: 150_000n }, s, 27_000n, 500n)).toBe(false);
  });

  it("accrued borrow debt can push an at-boundary position under", () => {
    // Size 1e6, maintenance 50_000, collateral exactly at the line, no uPnL.
    const pos = {
      sizeUsd: 1_000_000n,
      collateral: 50_000n,
      entryPrice: 30_000n,
      fundingFeeCheckpoint: 0n,
      fundingCreditCheckpoint: 0n,
      borrowCheckpoint: 0n,
      isLong: true,
    };
    // Market idle for 60s with a max borrow rate: drift = 100_000 × 60 × 1e18 / 1e6 = 6e18
    // → owed = 1e6 × 6e18 / 1e18 = 6_000_000 (6 gUSD) → equity −5_950_000 < 50_000.
    const idle = mkMarket({ borrowRatePpmPerSec: 100_000n, fundingUpdatedAtSec: 940n });
    const s = settle(idle, advanceFunding(idle, 1_000n), pos);
    expect(s.borrow).toBe(6_000_000n);
    expect(isLiquidatable(pos, s, 30_000n, 500n)).toBe(true);
    // Same position at zero elapsed time stays exactly at the line.
    const fresh = mkMarket({ borrowRatePpmPerSec: 100_000n, fundingUpdatedAtSec: 1_000n });
    const s0 = settle(fresh, advanceFunding(fresh, 1_000n), pos);
    expect(isLiquidatable(pos, s0, 30_000n, 500n)).toBe(false);
  });
});

describe("trigger + acceptable-price matrices", () => {
  it("triggerMet mirrors _checkTrigger", () => {
    // TP: long exits high, short exits low.
    expect(triggerMet("TakeProfit", true, 31_000n, 30_000n)).toBe(true);
    expect(triggerMet("TakeProfit", true, 29_999n, 30_000n)).toBe(false);
    expect(triggerMet("TakeProfit", false, 29_999n, 30_000n)).toBe(true);
    expect(triggerMet("TakeProfit", false, 30_001n, 30_000n)).toBe(false);
    // SL: long exits low, short exits high; boundary is inclusive (<= / >=).
    expect(triggerMet("StopLoss", true, 29_000n, 30_000n)).toBe(true);
    expect(triggerMet("StopLoss", true, 30_000n, 30_000n)).toBe(true);
    expect(triggerMet("StopLoss", true, 30_001n, 30_000n)).toBe(false);
    expect(triggerMet("StopLoss", false, 31_000n, 30_000n)).toBe(true);
    expect(triggerMet("StopLoss", false, 29_999n, 30_000n)).toBe(false);
  });

  it("acceptablePriceMet mirrors the engine's bounds", () => {
    // Increase: long buys cheap (≤), short sells dear (≥).
    expect(acceptablePriceMet(true, true, 29_999n, 30_000n)).toBe(true);
    expect(acceptablePriceMet(true, true, 30_001n, 30_000n)).toBe(false);
    expect(acceptablePriceMet(false, true, 30_001n, 30_000n)).toBe(true);
    expect(acceptablePriceMet(false, true, 29_999n, 30_000n)).toBe(false);
    // Decrease: long closes dear (≥), short closes cheap (≤).
    expect(acceptablePriceMet(true, false, 30_001n, 30_000n)).toBe(true);
    expect(acceptablePriceMet(true, false, 29_999n, 30_000n)).toBe(false);
    expect(acceptablePriceMet(false, false, 29_999n, 30_000n)).toBe(true);
    expect(acceptablePriceMet(false, false, 30_001n, 30_000n)).toBe(false);
  });
});

describe("scalePrice", () => {
  it("matches the attestor's Math.round × PRICE_SCALE", () => {
    expect(scalePrice(3.25)).toBe(32_500n);
    expect(scalePrice(3.250049)).toBe(32_500n);
    expect(scalePrice(3.25005)).toBe(32_501n);
    expect(scalePrice(299.9999)).toBe(2_999_999n);
  });
});

describe("equity", () => {
  it("is collateral + uPnL − debts", () => {
    const pos = {
      sizeUsd: 1_000_000n,
      collateral: 100_000n,
      entryPrice: 30_000n,
      fundingFeeCheckpoint: 0n,
      fundingCreditCheckpoint: 0n,
      borrowCheckpoint: 0n,
      isLong: false,
    };
    const s = { owed: 500n, earned: 200n, borrow: 300n };
    // short at price 27_000 → uPnL +100_000; equity = 100_000 + 100_000 − 800.
    expect(equity(pos, s, 27_000n)).toBe(199_200n);
  });
});