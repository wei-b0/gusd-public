/**
 * Offline replication of the engine's perp math — `PerpMath` + the accrual
 * step of `PerpFunding` — down to every rounding direction. The keeper uses
 * it ONLY to decide that work exists; the one eth_call sim against the real
 * engine is the gate before any broadcast. Where this module errs, the sim
 * reverts and the item waits for the next tick.
 *
 * Scales (mirroring PerpMath.sol — changing either side requires the other):
 *   gUSD amounts        6-dec (bigint)
 *   prices              4-dec (bigint) — PRICE_SCALE = 10_000
 *   bps                 1e4
 *   funding cumulatives WAD (1e18) per unit of USD notional
 *   rates               ppm per second, MAX_RATE_PPM_PER_SEC = 100_000
 */

export const BPS = 10_000n;
export const FUNDING_SCALE = 10n ** 18n;
export const PPM = 1_000_000n;
export const MAX_RATE_PPM_PER_SEC = 100_000n;
/** PerpFunding.MAX_WINDOW — the accrual clamp, per window. */
export const MAX_WINDOW_SEC = 3600n;
export const PRICE_SCALE = 10_000n;

export type Rounding = "floor" | "ceil";

function mulDiv(a: bigint, b: bigint, d: bigint, r: Rounding = "floor"): bigint {
  const n = a * b;
  const q = n / d;
  if (r === "floor" || n % d === 0n) return q;
  // bigint / truncates toward zero; operands here are non-negative.
  return q + 1n;
}

/** PerpMath.feeBps — fees ceil (the ledger gains the dust). */
export function feeBps(amount: bigint, bps: bigint): bigint {
  return mulDiv(amount, bps, BPS, "ceil");
}

/** PerpMath.maintenance — the margin floor ceils (conservative). */
export function maintenance(sizeUsd: bigint, mmBps: bigint): bigint {
  return mulDiv(sizeUsd, mmBps, BPS, "ceil");
}

/**
 * PerpMath.pnl — signed unrealized PnL. Positive payouts floor; loss
 * magnitudes ceil; both directions favor the vault.
 */
export function pnl(sizeUsd: bigint, entry: bigint, isLong: boolean, price: bigint): bigint {
  if (sizeUsd === 0n || price === entry) return 0n;
  const wins = isLong ? price > entry : price < entry;
  if (wins) {
    const deltaUp = isLong ? price - entry : entry - price;
    return mulDiv(sizeUsd, deltaUp, entry, "floor");
  }
  const delta = isLong ? entry - price : price - entry;
  return -mulDiv(sizeUsd, delta, entry, "ceil");
}

/** PerpMath.fundingOwed — charges ceil. */
export function fundingOwed(sizeUsd: bigint, cum: bigint, checkpoint: bigint): bigint {
  if (cum <= checkpoint) return 0n;
  return mulDiv(sizeUsd, cum - checkpoint, FUNDING_SCALE, "ceil");
}

/** PerpMath.fundingEarned — credits floor. */
export function fundingEarned(sizeUsd: bigint, cum: bigint, checkpoint: bigint): bigint {
  if (cum <= checkpoint) return 0n;
  return mulDiv(sizeUsd, cum - checkpoint, FUNDING_SCALE, "floor");
}

/** PerpMath.skewFraction — |long − short| / total OI as a WAD in [0, 1e18]. */
export function skewFraction(longOi: bigint, shortOi: bigint): bigint {
  const totalOi = longOi + shortOi;
  if (totalOi === 0n) return 0n;
  const skew = longOi >= shortOi ? longOi - shortOi : shortOi - longOi;
  return mulDiv(skew, FUNDING_SCALE, totalOi, "floor");
}

/** PerpMath.fundingDrift — one window's skew drift, floor (one mulDiv). */
export function fundingDrift(ratePpm: bigint, windowSec: bigint, skewFrac: bigint): bigint {
  return mulDiv(ratePpm, windowSec * skewFrac, PPM, "floor");
}

/** PerpMath.borrowDrift — one window's borrow drift, ceil. */
export function borrowDrift(ratePpm: bigint, windowSec: bigint): bigint {
  return mulDiv(ratePpm, windowSec * FUNDING_SCALE, PPM, "ceil");
}

/** A market's funding cumulatives as the keeper stores them. */
export interface MarketFunding {
  openNotionalLong: bigint;
  openNotionalShort: bigint;
  fundingChargePerUnitLong: bigint;
  fundingChargePerUnitShort: bigint;
  fundingCreditPerUnitLong: bigint;
  fundingCreditPerUnitShort: bigint;
  borrowChargePerUnit: bigint;
  /** Chain seconds of the market's last accrual touch. */
  fundingUpdatedAtSec: bigint;
  /** Owner-set rates (the engine clamps funding to MAX_RATE_PPM_PER_SEC). */
  fundingRatePpmPerSec: bigint;
  borrowRatePpmPerSec: bigint;
}

export interface AdvancedFunding {
  fundingChargePerUnitLong: bigint;
  fundingChargePerUnitShort: bigint;
  fundingCreditPerUnitLong: bigint;
  fundingCreditPerUnitShort: bigint;
  borrowChargePerUnit: bigint;
  /** The window the advance applied — diagnostics only. */
  windowSec: bigint;
}

/**
 * PerpFunding.accrue, offline: advances the stored cumulatives to `nowSec`
 * with the engine's exact shape — ONE window clamped at MAX_WINDOW (a single
 * accrual call inside the liquidate/execute tx clamps the whole idle gap to
 * one 3600s window, and so does this). Idempotent above `nowSec`.
 */
export function advanceFunding(m: MarketFunding, nowSec: bigint): AdvancedFunding {
  const out: AdvancedFunding = {
    fundingChargePerUnitLong: m.fundingChargePerUnitLong,
    fundingChargePerUnitShort: m.fundingChargePerUnitShort,
    fundingCreditPerUnitLong: m.fundingCreditPerUnitLong,
    fundingCreditPerUnitShort: m.fundingCreditPerUnitShort,
    borrowChargePerUnit: m.borrowChargePerUnit,
    windowSec: 0n,
  };
  if (nowSec <= m.fundingUpdatedAtSec) return out;
  const dt = nowSec - m.fundingUpdatedAtSec;
  const window = dt > MAX_WINDOW_SEC ? MAX_WINDOW_SEC : dt;
  out.windowSec = window;

  const skewFrac = skewFraction(m.openNotionalLong, m.openNotionalShort);
  if (skewFrac > 0n && m.fundingRatePpmPerSec > 0n) {
    const rate = m.fundingRatePpmPerSec > MAX_RATE_PPM_PER_SEC ? MAX_RATE_PPM_PER_SEC : m.fundingRatePpmPerSec;
    const drift = fundingDrift(rate, window, skewFrac);
    if (m.openNotionalLong >= m.openNotionalShort) {
      out.fundingChargePerUnitLong += drift;
      if (m.openNotionalShort > 0n) {
        out.fundingCreditPerUnitShort += mulDiv(drift, m.openNotionalLong, m.openNotionalShort, "floor");
      }
    } else {
      out.fundingChargePerUnitShort += drift;
      if (m.openNotionalLong > 0n) {
        out.fundingCreditPerUnitLong += mulDiv(drift, m.openNotionalShort, m.openNotionalLong, "floor");
      }
    }
  }
  if (m.borrowRatePpmPerSec > 0n) {
    out.borrowChargePerUnit += borrowDrift(m.borrowRatePpmPerSec, window);
  }
  return out;
}

/** A position as the keeper stores it (all money columns bigint). */
export interface PositionFunding {
  sizeUsd: bigint;
  collateral: bigint;
  entryPrice: bigint;
  fundingFeeCheckpoint: bigint;
  fundingCreditCheckpoint: bigint;
  borrowCheckpoint: bigint;
  isLong: boolean;
}

export interface Settlement {
  owed: bigint;
  earned: bigint;
  borrow: bigint;
}

/**
 * PerpFunding.settle against the ADVANCED cumulatives: the deltas the next
 * onchain touch will settle for this position. The checkpoint-rewind clamp
 * from `_chargeFunding` (uncollected debt follows the position) is NOT
 * replicated — its effect is that debt cannot exceed what the deltas say,
 * which is exactly what this returns.
 */
export function settle(m: MarketFunding, adv: AdvancedFunding, p: PositionFunding): Settlement {
  const feeCum = p.isLong ? adv.fundingChargePerUnitLong : adv.fundingChargePerUnitShort;
  const creditCum = p.isLong ? adv.fundingCreditPerUnitLong : adv.fundingCreditPerUnitShort;
  return {
    owed: fundingOwed(p.sizeUsd, feeCum, p.fundingFeeCheckpoint),
    earned: fundingEarned(p.sizeUsd, creditCum, p.fundingCreditCheckpoint),
    borrow: fundingOwed(p.sizeUsd, adv.borrowChargePerUnit, p.borrowCheckpoint),
  };
}

/** Equity at `price`: collateral + uPnL − (funding owed + borrow). */
export function equity(p: PositionFunding, s: Settlement, price: bigint): bigint {
  return p.collateral + pnl(p.sizeUsd, p.entryPrice, p.isLong, price) - (s.owed + s.borrow);
}

/**
 * The liquidation gate, offline — mirrors `PerpViews.liquidatableAt` /
 * `PerpLiquidation.liquidate`: equity < maintenance (fail-closed onchain;
 * the keeper's version is advisory).
 */
export function isLiquidatable(p: PositionFunding, s: Settlement, price: bigint, mmBps: bigint): boolean {
  if (p.sizeUsd === 0n) return false;
  return equity(p, s, price) < maintenance(p.sizeUsd, mmBps);
}

/**
 * The engine's `_checkTrigger`, offline. TP: long exits high, short exits
 * low; SL: long exits low, short exits high. SL has no floor by design.
 */
export function triggerMet(kind: "StopLoss" | "TakeProfit", isLong: boolean, price: bigint, trigger: bigint): boolean {
  return kind === "TakeProfit"
    ? isLong
      ? price >= trigger
      : price <= trigger
    : isLong
      ? price <= trigger
      : price >= trigger;
}

/** The engine's acceptable-price bound for a market (non-trigger) order. */
export function acceptablePriceMet(isLong: boolean, isIncrease: boolean, price: bigint, bound: bigint): boolean {
  if (isIncrease) {
    // Longs buy cheap (≤ bound), shorts sell dear (≥ bound).
    return isLong ? price <= bound : price >= bound;
  }
  // Longs close dear (≥ bound), shorts close cheap (≤ bound).
  return isLong ? price >= bound : price <= bound;
}

/**
 * A candidate tick's USD price on the report's 4-dec scale. The attestor
 * scales with Math.round(price × 10_000) (priceToScaled); the keeper uses
 * the same rounding for its pre-check. A null/degraded price scales to 0n —
 * callers skip before this.
 */
export function scalePrice(price: number): bigint {
  return BigInt(Math.round(price * Number(PRICE_SCALE)));
}