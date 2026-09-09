/**
 * Onchain unit conversion — parse/format at the seam where product numbers
 * (JS floats the UI trades in) meet wei-scale integers the contracts want.
 * Display goes through ./format.ts; this module owns only the decimal
 * vocabulary: gUSD/sgUSD and every whitelisted funding stable (the chain's
 * reserve asset included) are 6-decimal, GPU positions are 18-decimal.
 */

import { formatUnits, parseUnits } from "viem";

export const GUSD_DECIMALS = 6;
export const STABLE_DECIMALS = 6;
export const SGUSD_DECIMALS = 6;
/** GPU positions are 18-decimal ERC-20 units (one unit = one GPU-hour). */
export const GPU_TOKEN_DECIMALS = 18;

/** The order ledger prints GPU units at 4 decimals — signed floors are
 *  quantized to this raw grain (1e-4 units) so the displayed figure IS
 *  the signed figure. */
export const GPU_LEDGER_GRAIN = 10n ** (BigInt(GPU_TOKEN_DECIMALS) - 4n);

/** Floor a raw 18-dec unit amount to the ledger grain. */
export function floorToLedgerGrain(raw: bigint): bigint {
  return (raw / GPU_LEDGER_GRAIN) * GPU_LEDGER_GRAIN;
}

/** Product gUSD number → 6-decimal wei-scale integer. */
export function parseGusd(amount: number): bigint {
  return parseScaled(amount, GUSD_DECIMALS);
}

/** 6-decimal raw → product number. */
export function formatGusdRaw(raw: bigint): number {
  return Number(formatUnits(raw, GUSD_DECIMALS));
}

/** Product stable number (the reserve asset or any whitelisted stable) → 6-decimal raw. */
export function parseStable(amount: number): bigint {
  return parseScaled(amount, STABLE_DECIMALS);
}

/** 6-decimal stable raw → product number. */
export function formatStableRaw(raw: bigint): number {
  return Number(formatUnits(raw, STABLE_DECIMALS));
}

/** Product GPU size → 18-decimal raw. */
export function parseGpuUnits(size: number): bigint {
  return parseScaled(size, GPU_TOKEN_DECIMALS);
}

/** 18-decimal GPU raw → product number. */
export function formatGpuUnits(raw: bigint): number {
  return Number(formatUnits(raw, GPU_TOKEN_DECIMALS));
}

/**
 * Apply a bps amount to a raw bigint: `dir: "up"` multiplies by
 * (10_000 + bps)/10_000 (spend caps with slippage headroom), `dir: "down"`
 * by (10_000 − bps)/10_000 (minimums). Integer math, ceiling on the way up
 * and floor on the way down — never rounds below what the user promised.
 */
export function applyBps(raw: bigint, bps: number, dir: "up" | "down"): bigint {
  const scale = 10_000n;
  if (dir === "up") {
    return (raw * (scale + BigInt(bps)) + scale - 1n) / scale;
  }
  return (raw * (scale - BigInt(bps))) / scale;
}

/** bps → percent for display: 50 → 0.5 */
export function bpsToPct(bps: number): number {
  return bps / 100;
}

function parseScaled(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount < 0) return 0n;
  // viem's parseUnits wants a decimal string; going through one avoids
  // float artifacts (0.1 + 0.2 problems) at the boundary.
  return parseUnits(amount.toString(), decimals);
}
