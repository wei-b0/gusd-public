/**
 * Trade quotes — the execution stack the order slip signs against. Buys
 * are exact-out through `router.buy`: the desk prices the pool leg with
 * the hook-aware V4Quoter (the same pricing path execution runs) and the
 * issuance leg with the contract's own `quoteIssue`, then signs a
 * `maxPaid` cap the router pulls and refunds from. Sells are exact-in
 * through `router.sell`, signing a `minOut` payout floor. Neither quote
 * pre-commits the fill — state can move between eth_call and inclusion —
 * so execution is bounded by the signed limits, not by the quote.
 *
 * Honesty rules the math keeps: the quoter already runs the hook, so its
 * amount IS all-in — the protocol fee is split out for display only, and
 * LP fees stay inside the market leg rather than being fabricated as a
 * row. Fees live on the legs that incur them; the UI derives the fee
 * copy from the leg set, never from static market metadata. Genesis
 * pools hold no depth: the pool leg binary-searches what the pool can
 * actually fill and the remainder prices through issuance.
 */

import type { Address } from "viem";
import type { AssetId, TradeAvailability, TradeLeg, TradeQuote } from "@/domain/types";
import { applyBps, formatGpuUnits, parseGpuUnits } from "@/domain/units";
import { gpuIdForAsset } from "../gpu-id";
import { canonicalPoolKey, isBuyZeroForOne } from "../pool";
import { getContracts } from "../contracts";
import { getPublicClient } from "../public-client";
import { contractReads, type ContractReads } from "../reads";

/** Slippage tolerance the slip offers, bps (the presets row). */
export const TOLERANCE_PRESETS_BPS = [10, 50, 100] as const;
export const DEFAULT_TOLERANCE_BPS = 50;

/** Probe budget for the max-fillable pool search (log₂ of the size range). */
const PROBE_BUDGET = 10;

export interface QuoteDeps {
  reads: ContractReads;
  contracts: ReturnType<typeof getContracts>;
  getBlockNumber(): Promise<number>;
  now(): number;
}

export function defaultQuoteDeps(): QuoteDeps {
  return {
    reads: contractReads(),
    contracts: getContracts(),
    getBlockNumber: async () => Number(await getPublicClient().getBlockNumber()),
    now: Date.now,
  };
}

const UINT128_MAX = 2n ** 128n - 1n;

/** One single-pool quote argument — the v4 quoter's own params struct. */
export interface QuoteSingleParams {
  poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  zeroForOne: boolean;
  exactAmount: bigint;
  hookData: "0x";
}

/**
 * The quoter's quote functions are declared nonpayable (they call the
 * poolManager's unlock), so viem's getContract files them under write —
 * but they are pure simulations executed by eth_call. The read surface is
 * the honest seam; it is cast to the two signatures the desk uses. Shared
 * with the mint desk's StableRouter swap leg (quoterReadFor); the
 * deps-seamed quoterRead stays the trading stack's entry.
 */
export interface QuoterRead {
  quoteExactOutputSingle(args: [QuoteSingleParams]): Promise<[bigint, bigint]>;
  quoteExactInputSingle(args: [QuoteSingleParams]): Promise<[bigint, bigint]>;
}

export function quoterReadFor(contracts: ReturnType<typeof getContracts>): QuoterRead {
  return contracts.quoter.read as unknown as QuoterRead;
}

function quoterRead(deps: QuoteDeps): QuoterRead {
  return quoterReadFor(deps.contracts);
}

/**
 * One pool probe: gUSD required to buy `gpuOutRaw` from the pool, all-in
 * (LP fee + hook fee — the quoter runs the hook). Null when the pool
 * cannot fill the size (v4 reverts on insufficient liquidity).
 */
async function poolCostFor(
  deps: QuoteDeps,
  poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address },
  zeroForOne: boolean,
  gpuOutRaw: bigint,
): Promise<bigint | null> {
  try {
    const [amountIn] = await quoterRead(deps).quoteExactOutputSingle([
      { poolKey, zeroForOne, exactAmount: gpuOutRaw, hookData: "0x" },
    ]);
    return amountIn > 0n ? amountIn : null;
  } catch {
    // No depth for that size — the probe's honest answer.
    return null;
  }
}

/**
 * Binary-search the largest pool fill in (0, sizeRaw], given the full size
 * already failed. ~10 probes; cached per gpuId+block so a drifting desk
 * re-quotes without re-probing the same dry pool.
 */
async function maxFillable(
  deps: QuoteDeps,
  cacheKey: string,
  poolKey: Parameters<typeof poolCostFor>[1],
  zeroForOne: boolean,
  sizeRaw: bigint,
): Promise<{ fill: bigint; cost: bigint }> {
  const cached = probeCache.get(cacheKey);
  if (cached) return cached;
  let lo = 0n;
  let hi = sizeRaw;
  // ~PROBE_BUDGET halvings bound the search below any desk-relevant size.
  for (let i = 0; i < PROBE_BUDGET && hi - lo > 1n; i += 1) {
    const mid = lo + (hi - lo) / 2n;
    const cost = await poolCostFor(deps, poolKey, zeroForOne, mid);
    if (cost !== null) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const fill = lo;
  const cost = fill === 0n ? 0n : ((await poolCostFor(deps, poolKey, zeroForOne, fill)) ?? 0n);
  const result = { fill, cost };
  if (probeCache.size > 256) probeCache.clear();
  probeCache.set(cacheKey, result);
  return result;
}

/** Probe cache: `${gpuId}:${block}:${sizeRaw}` → the pool's max fill. */
const probeCache = new Map<string, { fill: bigint; cost: bigint }>();

/** Drop the probe cache (tests, or an operator forcing re-probes). */
export function disposeProbeCache(): void {
  probeCache.clear();
}

/** Availability read for the slip's gate — null when unregistered. Short
 *  TTL so the desk header and the slip share one read without drift. */
export async function describeAsset(
  asset: AssetId,
  deps: QuoteDeps = defaultQuoteDeps(),
): Promise<TradeAvailability | null> {
  const cached = availabilityCache.get(asset);
  if (cached && Date.now() - cached.at < AVAILABILITY_TTL_MS) {
    return cached.value;
  }
  let gpuId: `0x${string}`;
  try {
    gpuId = gpuIdForAsset(asset);
  } catch {
    return null;
  }
  const reg = await deps.reads.registration(gpuId);
  const value = reg
    ? {
        issuanceEnabled: reg.issuanceEnabled,
        poolRegistered: reg.poolRegistered,
        // v4 fee units are hundredths of a bip (3000 = 0.30%) — the
        // availability surface speaks bps, so convert here once.
        poolFeeBps: Number(reg.poolParams.fee) / 100,
        hookFeeBps: await deps.reads.hookFeeBps(),
        issuanceFeeBps: reg.issuanceFeeBps,
      }
    : null;
  availabilityCache.set(asset, { at: Date.now(), value });
  return value;
}

const AVAILABILITY_TTL_MS = 15_000;
const availabilityCache = new Map<AssetId, { at: number; value: TradeAvailability | null }>();

/** Drop the availability cache (tests). */
export function disposeAvailabilityCache(): void {
  availabilityCache.clear();
}

/** Buy quote: exact-out, pool leg + issuance leg, `maxPaid` cap with tolerance. */
export async function quoteBuy(
  asset: AssetId,
  size: number,
  toleranceBps: number = DEFAULT_TOLERANCE_BPS,
  deps: QuoteDeps = defaultQuoteDeps(),
): Promise<TradeQuote | null> {
  if (!Number.isFinite(size) || size <= 0) return null;
  let gpuId: `0x${string}`;
  try {
    gpuId = gpuIdForAsset(asset);
  } catch {
    return null;
  }
  const reg = await deps.reads.registration(gpuId);
  if (!reg) return null;
  const sizeRaw = parseGpuUnits(size);
  if (sizeRaw === 0n || sizeRaw > UINT128_MAX) return null;

  const { addresses } = deps.contracts;
  const poolKey = canonicalPoolKey(
    addresses.gusd as Address,
    reg.token,
    reg.poolParams,
    addresses.hook as Address,
  );
  const zeroForOne = isBuyZeroForOne(poolKey, addresses.gusd as Address);

  const blockNumber = await deps.getBlockNumber();
  let poolRaw = 0n;
  let poolCostRaw = 0n;
  if (reg.poolRegistered) {
    const full = await poolCostFor(deps, poolKey, zeroForOne, sizeRaw);
    if (full !== null) {
      poolRaw = sizeRaw;
      poolCostRaw = full;
    } else {
      const found = await maxFillable(
        deps,
        `${gpuId}:${blockNumber}:${sizeRaw}`,
        poolKey,
        zeroForOne,
        sizeRaw,
      );
      poolRaw = found.fill;
      poolCostRaw = found.cost;
    }
  }
  // Whatever depth can't fill must come from issuance — closed issuance
  // means the size is not buyable at all.
  const issueRaw = sizeRaw - poolRaw;
  if (issueRaw > 0n && !reg.issuanceEnabled) return null;

  let issuanceTotalRaw = 0n;
  let issuanceFeeRaw = 0n;
  if (issueRaw > 0n) {
    const [base, fee, total] = await deps.contracts.issuance.read.quoteIssue([gpuId, issueRaw]);
    issuanceFeeRaw = fee;
    issuanceTotalRaw = total;
    if (base === 0n && total === 0n) return null; // no oracle publication
  }

  // Legs carry their own fees — the UI derives the fee copy from this set,
  // so the slip never shows a fee this fill doesn't incur. The pool leg's
  // amountIn already carries the hook's take; split it out for the fee line
  // only — the row that signs is the all-in total.
  const legs: TradeLeg[] = [];
  if (poolRaw > 0n) {
    const hookFeeBps = Number(await deps.contracts.hook.read.hookFeeBps());
    const poolNetRaw = (poolCostRaw * 10_000n) / (10_000n + BigInt(hookFeeBps));
    legs.push({
      kind: "pool",
      gpuUnits: formatGpuUnits(poolRaw),
      gUsd: Number(poolCostRaw) / 1e6,
      fees: { protocol: Number(poolCostRaw - poolNetRaw) / 1e6 },
    });
  }
  if (issueRaw > 0n) {
    legs.push({
      kind: "issuance",
      gpuUnits: formatGpuUnits(issueRaw),
      gUsd: Number(issuanceTotalRaw) / 1e6,
      fees: { issuance: Number(issuanceFeeRaw) / 1e6 },
    });
  }

  const notionalRaw = poolCostRaw + issuanceTotalRaw;
  if (notionalRaw === 0n) return null;
  const maxPaidRaw = applyBps(notionalRaw, toleranceBps, "up");

  return {
    asset,
    side: "buy",
    size,
    price: Number(notionalRaw) / 1e6 / size,
    notional: Number(notionalRaw) / 1e6,
    maxPaid: Number(maxPaidRaw) / 1e6,
    minOut: 0,
    legs,
    toleranceBps,
    quotedAtMs: deps.now(),
    blockNumber,
  };
}

/** Sell quote: exact-in, all proceeds to gUSD, `minOut` floor with tolerance. */
export async function quoteSell(
  asset: AssetId,
  size: number,
  toleranceBps: number = DEFAULT_TOLERANCE_BPS,
  deps: QuoteDeps = defaultQuoteDeps(),
): Promise<TradeQuote | null> {
  if (!Number.isFinite(size) || size <= 0) return null;
  let gpuId: `0x${string}`;
  try {
    gpuId = gpuIdForAsset(asset);
  } catch {
    return null;
  }
  const reg = await deps.reads.registration(gpuId);
  if (!reg || !reg.poolRegistered) return null; // sells need secondary depth
  const sizeRaw = parseGpuUnits(size);
  if (sizeRaw === 0n || sizeRaw > UINT128_MAX) return null;

  const { addresses } = deps.contracts;
  const poolKey = canonicalPoolKey(
    addresses.gusd as Address,
    reg.token,
    reg.poolParams,
    addresses.hook as Address,
  );
  // Sells run GPU → gUSD: the opposite direction of a buy.
  const zeroForOne = !isBuyZeroForOne(poolKey, addresses.gusd as Address);

  const blockNumber = await deps.getBlockNumber();
  let netRaw: bigint;
  try {
    const [amountOut] = await quoterRead(deps).quoteExactInputSingle([
      { poolKey, zeroForOne, exactAmount: sizeRaw, hookData: "0x" },
    ]);
    netRaw = amountOut;
  } catch {
    return null; // no depth — the honest "can't quote"
  }
  if (netRaw === 0n) return null;

  // The swap's amountOut is net of the hook's take; restore the gross for
  // the fee line. The row that signs is the net.
  const { hook } = deps.contracts;
  const hookFeeBps = Number(await hook.read.hookFeeBps());
  const grossRaw = (netRaw * 10_000n) / (10_000n - BigInt(hookFeeBps));
  const protocolFeeRaw = grossRaw - netRaw;

  const minOutRaw = applyBps(netRaw, toleranceBps, "down");

  return {
    asset,
    side: "sell",
    size,
    price: Number(netRaw) / 1e6 / size,
    notional: Number(netRaw) / 1e6,
    maxPaid: 0,
    minOut: Number(minOutRaw) / 1e6,
    legs: [
      {
        kind: "pool",
        gpuUnits: size,
        gUsd: Number(netRaw) / 1e6,
        fees: { protocol: Number(protocolFeeRaw) / 1e6 },
      },
    ],
    toleranceBps,
    quotedAtMs: deps.now(),
    blockNumber,
  };
}

export async function quoteAsset(
  asset: AssetId,
  side: "buy" | "sell",
  size: number,
  toleranceBps: number = DEFAULT_TOLERANCE_BPS,
  deps: QuoteDeps = defaultQuoteDeps(),
): Promise<TradeQuote | null> {
  return side === "buy"
    ? quoteBuy(asset, size, toleranceBps, deps)
    : quoteSell(asset, size, toleranceBps, deps);
}
