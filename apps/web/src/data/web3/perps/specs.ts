/**
 * Perp tx specs — every argument mirrors IGpuPerpEngine.sol one-to-one:
 * OrderParams rides as one struct tuple; cancel/claim take flat args. All
 * amounts are raw onchain units (gUSD 6-dec, prices ×10_000). The engine
 * pulls collateral + execution fee from the caller at createOrder, so the
 * plan carries the approval; cancel/claim move nothing in.
 */

import type { Address, Hex } from "viem";
import type { TxSpec } from "@/domain/types";
import { getContracts } from "../contracts";
import { GPU_PERP_ENGINE_ABI } from "../abis/gpu_perp_engine";

/** OrderKind on the engine — numeric, OrderParams order exactly. */
export const PERP_ORDER_KIND = {
  open: 0,
  close: 1,
  "stop-loss": 2,
  "take-profit": 3,
} as const;

export interface PerpOrderSpecParams {
  /** The market's gpuId (bytes32 left-aligned SKU). */
  market: Hex;
  kind: (typeof PERP_ORDER_KIND)[keyof typeof PERP_ORDER_KIND];
  isLong: boolean;
  /** Raw 6-dec USD notional delta. */
  sizeDeltaUsd: bigint;
  /** Raw 6-dec collateral delta — increase orders only, 0 otherwise. */
  collateralDeltaUsd: bigint;
  /** Raw ×10_000 acceptable price — increase/decrease only, 0 on triggers. */
  acceptablePrice: bigint;
  /** Raw ×10_000 trigger level — triggers only, 0 on market orders. */
  triggerPrice: bigint;
  /** Raw 6-dec execution fee (the engine's MIN_EXECUTION_FEE floor). */
  executionFee: bigint;
}

export function perpCreateOrderSpec(params: PerpOrderSpecParams): TxSpec {
  return {
    origin: perpOriginFor(params.kind),
    kind: "perp-create-order",
    async execute(wallet) {
      const hash = await wallet.writeContract({
        address: getContracts().addresses.perpEngine as Address,
        abi: GPU_PERP_ENGINE_ABI,
        functionName: "createOrder",
        args: [
          {
            market: params.market,
            kind: params.kind,
            isLong: params.isLong,
            sizeDeltaUsd: params.sizeDeltaUsd,
            collateralDeltaUsd: params.collateralDeltaUsd,
            acceptablePrice: params.acceptablePrice,
            triggerPrice: params.triggerPrice,
            executionFee: params.executionFee,
          },
        ],
        account: wallet.account ?? null,
        chain: null,
      });
      return { hash };
    },
  };
}

export function perpCancelSpec(orderId: bigint): TxSpec {
  return {
    origin: "perp-cancel",
    kind: "perp-cancel-order",
    async execute(wallet) {
      const hash = await wallet.writeContract({
        address: getContracts().addresses.perpEngine as Address,
        abi: GPU_PERP_ENGINE_ABI,
        functionName: "cancelOrder",
        args: [orderId],
        account: wallet.account ?? null,
        chain: null,
      });
      return { hash };
    },
  };
}

/** Settles the caller's claimable balance out of the sgUSD vault — no
 *  approval, the engine moves its own reserved assets. */
export function perpClaimSpec(amount: bigint, to: Address): TxSpec {
  return {
    origin: "perp-claim",
    kind: "perp-claim",
    async execute(wallet) {
      const hash = await wallet.writeContract({
        address: getContracts().addresses.perpEngine as Address,
        abi: GPU_PERP_ENGINE_ABI,
        functionName: "claim",
        args: [amount, to],
        account: wallet.account ?? null,
        chain: null,
      });
      return { hash };
    },
  };
}

function perpOriginFor(kind: number): TxSpec["origin"] {
  switch (kind) {
    case PERP_ORDER_KIND.close:
      return "perp-close";
    case PERP_ORDER_KIND["stop-loss"]:
    case PERP_ORDER_KIND["take-profit"]:
      return "perp-trigger";
    default:
      return "perp-open";
  }
}