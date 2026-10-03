/**
 * Trigger-order helpers — the TP/SL slice of the perp desk. The engine owns
 * the truth: `_checkTrigger` re-verifies the armed condition fail-closed
 * against the FRESH report at execution, and `_activeTrigger` enforces one
 * order per (account, market, side, kind) with create-with-replace. This
 * module mirrors the condition for display (why an armed trigger will or
 * won't fire at the live mark) and resolves the replace target.
 */

import type { Address } from "viem";
import { getContracts } from "../contracts";
import { gpuIdForAsset } from "../gpu-id";

/** The engine's `_checkTrigger`, offline. TP: long exits high, short exits
 *  low; SL: long exits low, short exits high. SL has no floor by design —
 *  a gapped SL fires at whatever the report says. */
export function triggerMet(
  kind: "stop-loss" | "take-profit",
  isLong: boolean,
  price: bigint,
  trigger: bigint,
): boolean {
  return kind === "take-profit"
    ? isLong
      ? price >= trigger
      : price <= trigger
    : isLong
      ? price <= trigger
      : price >= trigger;
}

/** The armed trigger order's id for a position side, or 0 when none. */
export async function activeTriggerId(
  owner: Address,
  asset: Parameters<typeof gpuIdForAsset>[0],
  side: "long" | "short",
  kind: "stop-loss" | "take-profit",
): Promise<bigint> {
  const kindId = kind === "stop-loss" ? 2 : 3;
  try {
    return await getContracts().perpEngine.read.activeTrigger([
      owner,
      gpuIdForAsset(asset),
      side === "long",
      kindId,
    ]);
  } catch {
    return 0n;
  }
}