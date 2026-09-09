/**
 * Trade action builders — the contract-facing half of the order slip.
 * Size-first buys go through `router.buy` (exact-out GPU, one composed
 * hook swap — native book → POL → issuance backstop — refunding the spend
 * cap); money-first buys go through `router.buyExactIn` (spend-exact: the
 * router pulls exactly `gusdMaxIn` — nothing is refunded — and delivers ≥
 * `minGpuOut` units; pool-only, so genesis buys stay on `router.buy` under
 * their refundable cap); sells through `router.sell` (exact-in GPU, payout
 * floor). Buy/sell params mirror GpuRouter.sol's BuyParams/SellParams
 * one-to-one; the exact-in buy takes flat args. All amounts are raw
 * onchain units.
 */

import type { Address } from "viem";
import type { TxSpec } from "@/domain/types";
import { getContracts } from "../contracts";
import { GPU_ROUTER_ABI } from "../abis/gpu_router";

/** Deadline the desk puts on trade signatures — ten minutes, plenty for
 *  approve+sign+send, short enough that a stuck order can't fill at a
 *  price the user signed long ago. */
export const TRADE_DEADLINE_SECS = 600;

/** GpuRouter.BuyParams — exact-out GPU, gUSD-equivalent spend cap. */
export interface BuyParams {
  gpuId: `0x${string}`;
  /** Total GPU the recipient must receive (18-dec raw). */
  gpuOut: bigint;
  /** Payment asset — gUSD in v1. */
  payment: Address;
  /** gUSD-equivalent spend cap; unconsumed funds are refunded. */
  maxPaid: bigint;
  /** Unix seconds; the router reverts after it (0 = no deadline). */
  deadline: bigint;
  sqrtLimitX96: bigint;
  /** 0 = msg.sender; the desk always names the session wallet. */
  recipient: Address;
}

/** GpuRouter.SellParams — exact-in GPU, payout floor in payout units. */
export interface SellParams {
  gpuId: `0x${string}`;
  /** GPU sold (18-dec raw). */
  gpuIn: bigint;
  /** Payout asset — gUSD in v1. */
  payout: Address;
  /** Minimum payout, payout units. */
  minOut: bigint;
  /** Unix seconds; the router reverts after it (0 = no deadline). */
  deadline: bigint;
  sqrtLimitX96: bigint;
  /** 0 = msg.sender; the desk always names the session wallet. */
  recipient: Address;
}

/** Buy GPU: pulls `maxPaid` gUSD, fills the composed market, refunds the rest. */
export function buySpec(params: Omit<BuyParams, "recipient">, recipient: Address): TxSpec {
  return {
    origin: "trade",
    kind: "trade-buy",
    async execute(wallet) {
      const hash = await wallet.writeContract({
        address: getContracts().addresses.router,
        abi: GPU_ROUTER_ABI,
        functionName: "buy",
        args: [{ ...params, recipient }],
        account: wallet.account ?? null,
        chain: null,
      });
      return { hash };
    },
  };
}

/** Sell GPU: pulls `gpuIn` from the seller, pays out gUSD ≥ `minOut`. */
export function sellSpec(params: Omit<SellParams, "recipient">, recipient: Address): TxSpec {
  return {
    origin: "trade",
    kind: "trade-sell",
    async execute(wallet) {
      const hash = await wallet.writeContract({
        address: getContracts().addresses.router,
        abi: GPU_ROUTER_ABI,
        functionName: "sell",
        args: [{ ...params, recipient }],
        account: wallet.account ?? null,
        chain: null,
      });
      return { hash };
    },
  };
}

/** Flat args of GpuRouter.buyExactIn — no params struct on this entrypoint. */
export interface BuyExactInParams {
  gpuId: `0x${string}`;
  /** gUSD pulled from the buyer — spent in full, no refund (6-dec raw). */
  gusdMaxIn: bigint;
  /** Minimum GPU the recipient must receive (18-dec raw, ledger-grain). */
  minGpuOut: bigint;
  /** Unix seconds; the router reverts after it (0 = no deadline). */
  deadline: bigint;
  sqrtLimitX96: bigint;
  /** 0 = msg.sender; the desk always names the session wallet. */
  recipient: Address;
}

/** Buy GPU spend-exact: pulls exactly `gusdMaxIn` gUSD, delivers ≥
 *  `minGpuOut` GPU. Pool-only — the router reverts NotCanonicalPool
 *  without one, so genesis buys never ride this spec. */
export function buyExactInSpec(
  params: Omit<BuyExactInParams, "recipient">,
  recipient: Address,
): TxSpec {
  return {
    origin: "trade",
    kind: "trade-buy",
    async execute(wallet) {
      const hash = await wallet.writeContract({
        address: getContracts().addresses.router,
        abi: GPU_ROUTER_ABI,
        functionName: "buyExactIn",
        args: [params.gpuId, params.gusdMaxIn, params.minGpuOut, params.deadline, params.sqrtLimitX96, recipient],
        account: wallet.account ?? null,
        chain: null,
      });
      return { hash };
    },
  };
}
