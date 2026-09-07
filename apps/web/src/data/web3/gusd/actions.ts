/**
 * gUSD mint/redeem action builders — the contract-facing half of the mint
 * desk. The reserve-asset path is 1:1 against the GUSD contract: mint pulls
 * the underlying and mints gUSD net of the mint fee; redeem burns the
 * sender's gUSD and pays the underlying net of the redeem fee. A whitelisted
 * stable that is NOT the reserve rides the StableRouter: one exact-in v4
 * swap stable ⇄ underlying (minOut-bounded), then the same GUSD
 * mint/redeem inside the router. Previews are execution-identical — GUSD's
 * own preview functions on the reserve path, the hook-free v4 quoter for
 * the swap leg — nothing here estimates.
 */

import type { Address } from "viem";
import type { TxSpec } from "@/domain/types";
import { applyBps, parseGusd, parseStable } from "@/domain/units";
import { getContracts } from "../contracts";
import { contractReadsWithIndexer } from "../reads-protocol";
import { GUSD_ABI } from "../abis/gusd";
import { STABLE_ROUTER_ABI } from "../abis/stable_router";
import { planApproval, type ApprovalNeed } from "../approvals";
import { canonicalPoolKey, type PoolKey } from "../pool";
import { stableMetaOf } from "../stables";
import { quoterReadFor, type QuoteSingleParams } from "../trading/quotes";

/** Slippage headroom applied to the swap leg's conversion (the pool fee is
 *  inside the quote; this clips movement between quote and inclusion). */
export const SWAP_TOLERANCE_BPS = 50;

/**
 * The {stable, underlying} pool StableRouter flows route through. The
 * contract accepts any plain v4 pool (minOut bounds price); the desk quotes
 * against the stable-pool tier where LPs provision funding depth. When no
 * pool exists the quote fails closed — the desk never fabricates a route.
 */
export const STABLE_POOL = { fee: 100, tickSpacing: 1 } as const;

/** The reserve path's execution-identical preview, raw units. Fee is on the
 *  input, in reserve-asset (gUSD-equivalent) units. */
export interface GusdFlowQuote {
  /** Mint: gUSD out. Redeem: underlying out. Raw units. */
  outputRaw: bigint;
  /** The mint/redeem fee, raw reserve-asset units. */
  feeRaw: bigint;
  feeBps: number;
  paused: boolean;
}

/** Mint preview: reserve asset in → gUSD out (raw). */
export async function quoteMint(underlyingAmountRaw: bigint): Promise<GusdFlowQuote> {
  const { gusd } = getContracts();
  const reads = contractReadsWithIndexer();
  const [gusdOutRaw, state] = await Promise.all([
    gusd.read.previewMint([underlyingAmountRaw]),
    reads.gusdState(),
  ]);
  return {
    outputRaw: gusdOutRaw,
    feeRaw: underlyingAmountRaw - gusdOutRaw,
    feeBps: state.mintFeeBps,
    paused: state.paused,
  };
}

/** Redeem preview: gUSD in → underlying out (raw). */
export async function quoteRedeem(gusdAmountRaw: bigint): Promise<GusdFlowQuote> {
  const { gusd } = getContracts();
  const reads = contractReadsWithIndexer();
  const [underlyingOutRaw, state] = await Promise.all([
    gusd.read.previewRedeem([gusdAmountRaw]),
    reads.gusdState(),
  ]);
  return {
    outputRaw: underlyingOutRaw,
    feeRaw: gusdAmountRaw - underlyingOutRaw,
    feeBps: state.redeemFeeBps,
    paused: state.paused,
  };
}

/** One StableRouter mint quote, raw units: `stable` → reserve → gUSD.
 *  Null when the pool cannot price the swap (no funding pool exists yet) —
 *  the honest answer, never a fabricated route. */
export interface StableMintQuote {
  stable: Address;
  amountInRaw: bigint;
  /** The reserve the pool leg delivers (pre-fee mint input). */
  underlyingInRaw: bigint;
  /** `underlyingInRaw` clipped by the swap tolerance — the signed floor. */
  minUnderlyingRaw: bigint;
  /** gUSD the mint produces from `underlyingInRaw`. */
  gusdOutRaw: bigint;
  feeBps: number;
  paused: boolean;
}

/** Mint preview through a non-reserve stable. */
export async function quoteMintViaStable(
  stable: Address,
  amountInRaw: bigint,
  toleranceBps: number = SWAP_TOLERANCE_BPS,
): Promise<StableMintQuote | null> {
  const { addresses, gusd } = getContracts();
  const underlying = addresses.underlying as Address;
  const [underlyingInRaw, state] = await Promise.all([
    quoteStableSwap(stable, underlying, amountInRaw),
    contractReadsWithIndexer().gusdState(),
  ]);
  if (underlyingInRaw === null) return null;
  const minUnderlyingRaw = applyBps(underlyingInRaw, toleranceBps, "down");
  const gusdOutRaw = await gusd.read.previewMint([underlyingInRaw]);
  return {
    stable,
    amountInRaw,
    underlyingInRaw,
    minUnderlyingRaw,
    gusdOutRaw,
    feeBps: state.mintFeeBps,
    paused: state.paused,
  };
}

/** One StableRouter redeem quote, raw units: gUSD → reserve → `stable`. */
export interface StableRedeemQuote {
  stable: Address;
  gusdInRaw: bigint;
  /** The reserve GUSD.redeem produces (pre-swap swap input). */
  underlyingOutRaw: bigint;
  /** `underlyingOutRaw` clipped by the swap tolerance — the signed floor. */
  minStableRaw: bigint;
  /** Stable units the pool leg delivers. */
  stableOutRaw: bigint;
  feeBps: number;
  paused: boolean;
}

/** Redeem preview through a non-reserve stable. */
export async function quoteRedeemViaStable(
  stable: Address,
  gusdInRaw: bigint,
  toleranceBps: number = SWAP_TOLERANCE_BPS,
): Promise<StableRedeemQuote | null> {
  const { addresses } = getContracts();
  const underlying = addresses.underlying as Address;
  const reserveQuote = await quoteRedeem(gusdInRaw);
  const stableOutRaw = await quoteStableSwap(underlying, stable, reserveQuote.outputRaw);
  if (stableOutRaw === null) return null;
  return {
    stable,
    gusdInRaw,
    underlyingOutRaw: reserveQuote.outputRaw,
    minStableRaw: applyBps(stableOutRaw, toleranceBps, "down"),
    stableOutRaw,
    feeBps: reserveQuote.feeBps,
    paused: reserveQuote.paused,
  };
}

/** Exact-in quote across the {in, out} stable pair's funding pool. Null on
 *  any pool failure — no pool, no depth, no route. */
async function quoteStableSwap(
  tokenIn: Address,
  tokenOut: Address,
  amountInRaw: bigint,
): Promise<bigint | null> {
  const contracts = getContracts();
  const key = stablePoolKey(tokenIn, tokenOut);
  try {
    const [amountOut] = await quoterReadFor(contracts).quoteExactInputSingle([
      {
        poolKey: key,
        zeroForOne: key.currency0.toLowerCase() === tokenIn.toLowerCase(),
        exactAmount: amountInRaw,
        hookData: "0x",
      } satisfies QuoteSingleParams,
    ]);
    return amountOut > 0n ? amountOut : null;
  } catch {
    return null;
  }
}

/** The plain (hook-free) {stable, underlying} pool key, address-sorted. */
export function stablePoolKey(a: Address, b: Address): PoolKey {
  const [currency0, currency1] =
    a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return {
    currency0,
    currency1,
    fee: STABLE_POOL.fee,
    tickSpacing: STABLE_POOL.tickSpacing,
    hooks: "0x0000000000000000000000000000000000000000",
  };
}

/** The mint approval — reserve-asset spend lands on GUSD itself; any other
 *  whitelisted stable lands on the StableRouter. */
export async function planMintApproval(
  owner: Address,
  asset: Address,
  amountRaw: bigint,
): Promise<ApprovalNeed | null> {
  const { addresses } = getContracts();
  const underlying = addresses.underlying as Address;
  const isReserve = asset.toLowerCase() === underlying.toLowerCase();
  return planApproval(
    asset,
    stableMetaOf(asset)?.symbol ?? "the funding asset",
    isReserve ? addresses.gusd : addresses.stableRouter,
    isReserve ? "gusd" : "stableRouter",
    owner,
    amountRaw,
  );
}

/** Arguments the mint spec encodes. `poolKey` is required exactly when
 *  `asset` is not the reserve (the swap path's caller-supplied pool). */
export interface MintSpecArgs {
  asset: Address;
  amountInRaw: bigint;
  minUnderlyingOutRaw: bigint;
  poolKey: PoolKey | null;
  to: Address;
}

/** Mint gUSD from the funding stable. Reserve path: GUSD.mint directly. */
export function mintSpec(args: MintSpecArgs): TxSpec {
  const { addresses } = getContracts();
  const underlying = addresses.underlying as Address;
  const isReserve = args.asset.toLowerCase() === underlying.toLowerCase();
  if (isReserve) {
    return {
      origin: "mint",
      kind: "mint",
      async execute(wallet) {
        const hash = await wallet.writeContract({
          address: addresses.gusd,
          abi: GUSD_ABI,
          functionName: "mint",
          args: [args.amountInRaw, args.to],
          account: wallet.account ?? null,
          chain: null,
        });
        return { hash };
      },
    };
  }
  if (!args.poolKey) throw new Error("Mint via a non-reserve stable requires its funding pool.");
  const key = args.poolKey;
  return {
    origin: "mint",
    kind: "mint",
    async execute(wallet) {
      const hash = await wallet.writeContract({
        address: addresses.stableRouter,
        abi: STABLE_ROUTER_ABI,
        functionName: "mint",
        args: [args.asset, args.amountInRaw, args.minUnderlyingOutRaw, key, args.to],
        account: wallet.account ?? null,
        chain: null,
      });
      return { hash };
    },
  };
}

/** Arguments the redeem spec encodes. Same poolKey rule as MintSpecArgs. */
export interface RedeemSpecArgs {
  asset: Address;
  gusdInRaw: bigint;
  minStableOutRaw: bigint;
  poolKey: PoolKey | null;
  to: Address;
}

/** Redeem gUSD to the funding stable — approval-free on the reserve path
 *  (the contract burns the sender). */
export function redeemSpec(args: RedeemSpecArgs): TxSpec {
  const { addresses } = getContracts();
  const underlying = addresses.underlying as Address;
  const isReserve = args.asset.toLowerCase() === underlying.toLowerCase();
  if (isReserve) {
    return {
      origin: "redeem",
      kind: "redeem",
      async execute(wallet) {
        const hash = await wallet.writeContract({
          address: addresses.gusd,
          abi: GUSD_ABI,
          functionName: "redeem",
          args: [args.gusdInRaw, args.to],
          account: wallet.account ?? null,
          chain: null,
        });
        return { hash };
      },
    };
  }
  if (!args.poolKey) throw new Error("Redeem via a non-reserve stable requires its funding pool.");
  const key = args.poolKey;
  return {
    origin: "redeem",
    kind: "redeem",
    async execute(wallet) {
      const hash = await wallet.writeContract({
        address: addresses.stableRouter,
        abi: STABLE_ROUTER_ABI,
        functionName: "redeem",
        args: [args.asset, args.gusdInRaw, args.minStableOutRaw, key, args.to],
        account: wallet.account ?? null,
        chain: null,
      });
      return { hash };
    },
  };
}

/** Parse a desk amount into 6-decimal raw units for the given direction. */
export function parseMintAmount(direction: "mint" | "redeem", amount: number): bigint {
  return direction === "mint" ? parseStable(amount) : parseGusd(amount);
}
