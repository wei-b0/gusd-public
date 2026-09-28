/**
 * The specs are the contract-facing half of the order slip — their arg
 * packing must match GpuRouter.sol's ABI exactly. The exact-in buy takes
 * FLAT args, so a swap between `recipient` and `updateData` doesn't even
 * reach the chain: viem refuses to encode the report bytes into the
 * address slot, and the slip dies with InvalidAddressError before the
 * wallet is ever asked to sign. These tests round-trip every spec's args
 * through the deployed ABI so the packing can't silently drift again.
 */
import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, getAddress, type Abi, type WalletClient } from "viem";
import { GPU_ROUTER_ABI } from "../abis/gpu_router";
import { buyExactInSpec } from "./specs";

/** bytes32 gpuId — version byte 0x01 + ascii "H100_SXM_80GB", zero-padded. */
const GPU_ID = "0x01483130305f53584d5f38304742000000000000000000000000000000000000" as const;
const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const REPORT = "0xdeadbeef1234" as const;

/** A wallet stub that captures the writeContract call for inspection. */
function capturingWallet(): { client: WalletClient; call(): { functionName: string; args: readonly unknown[] } | null } {
  const captured: { call: { functionName: string; args: readonly unknown[] } | null } = { call: null };
  return {
    client: {
      writeContract: async (request: unknown) => {
        captured.call = request as { functionName: string; args: readonly unknown[] };
        return "0x0000000000000000000000000000000000000000000000000000000000000000";
      },
    } as unknown as WalletClient,
    call: () => captured.call,
  };
}

describe("trade specs pack GpuRouter calldata in ABI order", () => {
  it("buyExactIn rides (…, sqrtLimitX96, recipient, updateData) — report last, never on the address slot", async () => {
    const spec = buyExactInSpec(
      { gpuId: GPU_ID, gusdMaxIn: 1_000_000_000n, minGpuOut: 1n, deadline: 600n, sqrtLimitX96: 0n, updateData: REPORT },
      OWNER,
    );
    const wallet = capturingWallet();
    await spec.execute(wallet.client);

    const call = wallet.call();
    expect(call?.functionName).toBe("buyExactIn");

    // The old packing put updateData on the recipient slot — viem refuses
    // to encode bytes into an address-typed param, so this line is the
    // sentinel: the spec's args must encode against the deployed ABI.
    const data = encodeFunctionData({
      abi: GPU_ROUTER_ABI as unknown as Abi,
      functionName: "buyExactIn",
      args: call?.args as never,
    });
    const decoded = decodeFunctionData({ abi: GPU_ROUTER_ABI as never, data });
    expect(decoded.functionName).toBe("buyExactIn");

    const flat = decoded.args as unknown as [`0x${string}`, bigint, bigint, bigint, bigint, `0x${string}`, `0x${string}`];
    expect(getAddress(flat[5])).toBe(getAddress(OWNER)); // recipient
    expect(flat[6]).toBe(REPORT); // the signed report rides LAST
    expect(flat[0]).toBe(GPU_ID);
    expect(flat[1]).toBe(1_000_000_000n); // gusdMaxIn
    expect(flat[2]).toBe(1n); // minGpuOut
  });
});
