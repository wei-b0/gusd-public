import { describe, expect, it } from "vitest";
import {
  canonicalPoolKey,
  gpuCurrencyOf,
  isBuyZeroForOne,
  poolIdOf,
} from "./pool";
import { GPU_HOOK_ABI } from "./abis/gpu_hook";

// Deterministic stand-ins; ordering math is what's under test, not identity.
const GUSD = "0x00000000000000000000000000000000000a0001" as const;
const GPU_TOKEN = "0x00000000000000000000000000000000000b0002" as const;
const HOOK = "0x00000000000000000000000000000000000c0003" as const;

describe("canonical pool derivation", () => {
  it("sorts currencies by address and carries pool params", () => {
    const key = canonicalPoolKey(GUSD, GPU_TOKEN, { fee: 3000, tickSpacing: 60 }, HOOK);
    expect(key.currency0.toLowerCase()).toBe(GUSD.toLowerCase());
    expect(key.currency1.toLowerCase()).toBe(GPU_TOKEN.toLowerCase());
    expect(key.fee).toBe(3000);
    expect(key.tickSpacing).toBe(60);
    expect(key.hooks.toLowerCase()).toBe(HOOK.toLowerCase());
  });

  it("flips ordering when the GPU token sorts below gUSD", () => {
    const lowToken = "0x0000000000000000000000000000000000000042" as const;
    const key = canonicalPoolKey(GUSD, lowToken, { fee: 3000, tickSpacing: 60 }, HOOK);
    expect(key.currency0.toLowerCase()).toBe(lowToken.toLowerCase());
    expect(key.currency1.toLowerCase()).toBe(GUSD.toLowerCase());
  });

  it("marks gUSD-as-currency0 as zeroForOne buy direction", () => {
    const buyKey = canonicalPoolKey(GUSD, GPU_TOKEN, { fee: 3000, tickSpacing: 60 }, HOOK);
    expect(isBuyZeroForOne(buyKey, GUSD)).toBe(true);
    expect(gpuCurrencyOf(buyKey, GUSD).toLowerCase()).toBe(GPU_TOKEN.toLowerCase());
  });

  it("marks GPU-as-currency0 pools the other way round", () => {
    const lowToken = "0x0000000000000000000000000000000000000042" as const;
    const key = canonicalPoolKey(GUSD, lowToken, { fee: 3000, tickSpacing: 60 }, HOOK);
    expect(isBuyZeroForOne(key, GUSD)).toBe(false);
    expect(gpuCurrencyOf(key, GUSD).toLowerCase()).toBe(lowToken.toLowerCase());
  });

  it("derives a stable 32-byte PoolId (keccak of the encoded key)", () => {
    const key = canonicalPoolKey(GUSD, GPU_TOKEN, { fee: 3000, tickSpacing: 60 }, HOOK);
    const id = poolIdOf(key);
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(poolIdOf({ ...key })).toBe(id);
    expect(poolIdOf({ ...key, fee: 500 })).not.toBe(id);
  });

  it("the hook ABI the key points at carries the swap permissions surface", () => {
    // Sanity: the synced GPU hook ABI is the swap-bearing contract, not a
    // stand-in — beforeSwap/afterSwap entries must exist.
    const names = GPU_HOOK_ABI.map((e) => ("name" in e ? e.name : ""));
    expect(names).toContain("beforeSwap");
    expect(names).toContain("afterSwap");
    expect(names).toContain("harvestTradingFees");
  });
});
