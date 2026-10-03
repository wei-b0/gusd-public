/**
 * Preview-time perp math — the shapes of `PerpMath.sol` the port must derive
 * BEFORE any calldata exists: the notional a collateral × leverage open
 * creates, the acceptable-price bound a market order signs, fee previews,
 * and the liquidation-distance display. The engine is authoritative —
 * `getPosition`/`getMarket` probes return the uPnL/equity/maintenance the
 * execution will recompute — so where this module rounds, it rounds the way
 * the contract does (fees/debts/ceilings ceil, payouts floor, entry bounds
 * against the trader) and never contradicts it by more than a dust grain.
 *
 * Scales (mirroring PerpMath.sol): gUSD amounts 6-dec bigint, prices ×10_000
 * bigint, bps 1e4, leverage in bps.
 */

/** Basis-point denominator (1x leverage = 10_000 bps). */
export const BPS = 10_000n;
/** Report price scale — a ×10_000 price. */
export const PRICE_SCALE = 10_000n;

export type Rounding = "floor" | "ceil";

/** Unsigned floor/ceil mulDiv — the engine's Math.mulDiv for non-negatives. */
export function mulDiv(a: bigint, b: bigint, d: bigint, r: Rounding = "floor"): bigint {
  const n = a * b;
  const q = n / d;
  if (r === "floor" || n % d === 0n) return q;
  return q + 1n; // operands are non-negative; / truncates toward zero
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
 * PerpMath.pnl — signed unrealized PnL (6-dec) of `sizeUsd` notional entered
 * at `entry`, marked at `price`. Positive payouts floor; loss magnitudes
 * ceil — both directions favor the vault.
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

/**
 * The notional a collateral × leverage open creates, floor — the engine
 * re-derives leverage as sizeΔ×1e4/collΔ CEIL, so flooring the size keeps
 * the signed leverage at or under what the user asked for.
 */
export function sizeFromCollateral(collateralRaw: bigint, leverageBps: bigint): bigint {
  return mulDiv(collateralRaw, leverageBps, BPS, "floor");
}

/** PerpMath's funding-cumulative scale (WAD per unit notional). */
export const FUNDING_SCALE = 10n ** 18n;

/** PerpMath.fundingOwed — a funding/borrow charge accrued by `sizeUsd`
 *  notional since `checkpoint`, rounded up (the charged side pays the dust). */
export function fundingOwed(sizeUsd: bigint, cum: bigint, checkpoint: bigint): bigint {
  if (cum <= checkpoint) return 0n;
  return mulDiv(sizeUsd, cum - checkpoint, FUNDING_SCALE, "ceil");
}

/** PerpMath.fundingEarned — a funding credit accrued by `sizeUsd` notional
 *  since `checkpoint`, rounded down (the credited side loses the dust). */
export function fundingEarned(sizeUsd: bigint, cum: bigint, checkpoint: bigint): bigint {
  if (cum <= checkpoint) return 0n;
  return mulDiv(sizeUsd, cum - checkpoint, FUNDING_SCALE, "floor");
}

/** The engine's createOrder leverage check, verbatim: sizeΔ×1e4/collΔ CEIL. */
export function leverageBpsCeil(sizeRaw: bigint, collateralRaw: bigint): bigint {
  return mulDiv(sizeRaw, BPS, collateralRaw, "ceil");
}

/**
 * The acceptable-price bound a market order signs, from the pinned report
 * price and the request's tolerance. The engine re-checks the bound against
 * the consumed report at execution (increase-long/decrease-short fill at
 * price ≤ bound; increase-short/decrease-long at price ≥ bound), so the
 * bound must sit on the tolerant side of the reference: a long buyer allows
 * slippage UP (ceil), a short seller down (floor); a long closer allows the
 * mark to fall (floor), a short closer to rise (ceil).
 */
export function acceptablePriceBound(
  price: bigint,
  toleranceBps: bigint,
  isLong: boolean,
  isIncrease: boolean,
): bigint {
  const tolerant = isLong === isIncrease
    ? mulDiv(price, BPS + toleranceBps, BPS, "ceil")
    : mulDiv(price, BPS - toleranceBps, BPS, "floor");
  return tolerant > 0n ? tolerant : 1n;
}

/**
 * Liquidation-price estimate for the position panel — where equity
 * (collateral + uPnL − funding/borrow debt) crosses the maintenance floor.
 * `fundingDebt` is the position's whole NET funding state (owed + borrow −
 * un-accrued earned − the carried earnedFunding balance): a net credit is
 * negative and widens the headroom, a net debt narrows it — no separate
 * balance argument, the identity callers compute already includes it.
 * Linearized at the entry (funding debt treated as fixed): a long
 * liquidates as the mark falls, a short as it rises, so the estimate rounds
 * toward the triggering side (floor for longs, ceil for shorts) — the
 * displayed figure can only understate the distance, never overstate it.
 * Null when the position carries no maintenance floor (mmBps 0).
 */
export function liquidationPriceEstimate(
  sizeUsd: bigint,
  collateral: bigint,
  entry: bigint,
  isLong: boolean,
  mmBps: bigint,
  fundingDebt: bigint,
): bigint | null {
  if (sizeUsd === 0n || entry === 0n || mmBps === 0n) return null;
  // margin beyond maintenance, as a fraction of notional:
  //   x = (collateral − maintenance − fundingDebt) / size
  // long:  liqPrice ≈ entry × (1 − x)    short: ≈ entry × (1 + x)
  const maint = maintenance(sizeUsd, mmBps);
  const headroom = collateral - maint - fundingDebt;
  const sign = isLong ? -1n : 1n;
  // entry × (1 + sign·x); the swing floors so the displayed boundary sits on
  // the conservative side in both directions — a long's displayed boundary
  // reads high (liquidation appears sooner), a short's reads low.
  const swing = mulDiv(entry, headroom, sizeUsd, "floor");
  const est = entry + sign * swing;
  if (est <= 0n) return 0n;
  return est;
}

/**
 * A report price (4-dec bigint) as a display float. The attestor scales with
 * Math.round(price × 10_000); this is the exact inverse.
 */
export function unscalePrice(price: bigint): number {
  return Number(price) / Number(PRICE_SCALE);
}