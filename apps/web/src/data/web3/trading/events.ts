/**
 * Trade receipt evidence — decode a confirmed router transaction back to
 * the fill the user made, from the contract's own Buy/Sell events. This is
 * receipt evidence for the action record's confirmed stamp, never a
 * display-price source and never history: the indexer owns history.
 */

import { parseEventLogs } from "viem";
import { getContracts } from "../contracts";
import { getPublicClient } from "../public-client";
import { GPU_ROUTER_ABI } from "../abis/gpu_router";
import { assetForGpuId } from "../gpu-id";
import { formatGpuUnits } from "@/domain/units";
import type { AssetId } from "@/domain/types";

export type TradeFill =
  | {
      kind: "buy";
      asset: AssetId | null;
      /** GPU units received, product units. */
      size: number;
      /** gUSD-equivalent paid (the refundable cap's consumed amount). */
      paid: number;
      /** The fee breakdown the event itself asserts, gUSD. */
      hookFee: number;
      issuanceFee: number;
    }
  | {
      kind: "sell";
      asset: AssetId | null;
      size: number;
      /** Payout delivered, gUSD. */
      out: number;
      hookFee: number;
    };

/** Decode one confirmed tx's Buy/Sell event, or null when it carries none. */
export async function decodeTradeResult(hash: `0x${string}`): Promise<TradeFill | null> {
  const client = getPublicClient();
  const receipt = await client.getTransactionReceipt({ hash });
  const router = getContracts().addresses.router;
  const logs = receipt.logs.filter((log) => log.address.toLowerCase() === router.toLowerCase());
  // viem's parseEventLogs wants the ABI widened; the synced readonly arrays
  // satisfy it at runtime. The result is asserted to the two event shapes
  // the router emits rather than trusting the `never`-widened inference.
  const parsed = parseEventLogs({ abi: GPU_ROUTER_ABI as never, logs: logs as never }) as unknown as
    readonly {
      eventName: string;
      args: Record<string, unknown>;
    }[];
  for (const log of parsed) {
    if (log.eventName === "Buy") {
      const args = log.args as {
        gpuId: `0x${string}`;
        gpuOut: bigint;
        paid: bigint;
        hookFee: bigint;
        issuanceFee: bigint;
      };
      return {
        kind: "buy",
        asset: assetForGpuId(args.gpuId),
        size: formatGpuUnits(args.gpuOut),
        paid: Number(args.paid) / 1e6,
        hookFee: Number(args.hookFee) / 1e6,
        issuanceFee: Number(args.issuanceFee) / 1e6,
      };
    }
    if (log.eventName === "Sell") {
      const args = log.args as {
        gpuId: `0x${string}`;
        gpuIn: bigint;
        out: bigint;
        hookFee: bigint;
      };
      return {
        kind: "sell",
        asset: assetForGpuId(args.gpuId),
        size: formatGpuUnits(args.gpuIn),
        out: Number(args.out) / 1e6,
        hookFee: Number(args.hookFee) / 1e6,
      };
    }
  }
  return null;
}
