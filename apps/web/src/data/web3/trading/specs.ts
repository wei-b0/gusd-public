/**
 * Trade action builders — the contract-facing half of the order slip.
 * Buys go through `router.buy` (exact-out GPU, one composed hook swap —
 * native book → POL → issuance backstop — refunding the spend cap); sells
 * through `router.sell` (exact-in GPU, payout floor). The structs mirror
 * GpuRouter.sol's BuyParams/SellParams one-to-one; all amounts are raw
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
