/**
 * Simulation primitive — every write simulates against the head before the
 * wallet is asked to sign, so contract reverts surface as amber validation
 * ("this would revert, here's why") instead of an onchain failure the user
 * paid gas for. V4Quoter quoting already runs the hook, so simulated swaps
 * are execution-accurate by construction.
 */

import type { Address } from "viem";
import { getPublicClient } from "./public-client";
import { normalizeActionError, type NormalizedError } from "./errors";

export interface SimulateWriteArgs {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
  account: Address;
}

export type SimulateResult =
  | { ok: true }
  | { ok: false; error: NormalizedError };

/**
 * Run one write in simulation mode. `ok: false` carries the normalized,
 * product-voiced error; the caller renders it and never requests a
 * signature for a reverting call.
 */
export async function simulateWrite(args: SimulateWriteArgs): Promise<SimulateResult> {
  const client = getPublicClient();
  try {
    await client.simulateContract({
      address: args.address,
      // viem's simulateContract wants a widened ABI shape; the synced
      // readonly arrays satisfy it at runtime.
      abi: args.abi as never,
      functionName: args.functionName as never,
      args: args.args as never,
      account: args.account,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: normalizeActionError(err) };
  }
}
