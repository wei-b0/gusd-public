/**
 * Trade action builders — the contract-facing half of the order slip.
 * Buys go through `router.buy` (exact-out, pool + issuance legs, refunding
 * spend cap); sells through `router.sell` (exact-in, payout floor). The
 * structs mirror GpuRouter.sol's BuyParams/SellParams one-to-one; all
 * amounts are raw onchain units.
 */

import type { Address } from "viem";
import type { TxSpec } from "@/domain/types";
import { getContracts } from "../contracts";
import { GPU_ROUTER_ABI } from "../abis/gpu_router";

/** GpuRouter.BuyParams — gUSD payment, gUSD-equivalent spend cap. */
export interface BuyParams {
  gpuId: `0x${string}`;
  /** Total GPU the recipient must receive (18-dec raw). */
  gpuOut: bigint;
  /** Portion filled from the canonical pool (18-dec raw). */
  poolGpuOut: bigint;
  /** Portion minted via primary issuance (18-dec raw). */
  issueGpuOut: bigint;
  /** Payment asset — gUSD in v1 (the reserve pays via the mint path). */
  payment: Address;
  /** gUSD-equivalent spend cap; unconsumed funds are refunded. */
  maxPaid: bigint;
  sqrtLimitX96: bigint;
  /** 0 = msg.sender; the desk always names the session wallet. */
  recipient: Address;
}

/** GpuRouter.SellParams — payout floor in payout units (gUSD in v1). */
export interface SellParams {
  gpuId: `0x${string}`;
  /** GPU sold (18-dec raw). */
  gpuIn: bigint;
  /** Payout asset — gUSD in v1. */
  payout: Address;
  /** Minimum payout, payout units. */
  minOut: bigint;
  sqrtLimitX96: bigint;
  recipient: Address;
}

/** Buy GPU: pulls `maxPaid` gUSD, fills pool + issuance, refunds the rest. */
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
