import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

/** viem partial mock — the transport layer is the seam; everything else
 *  (defineChain, the chain defs origin-reads imports) stays real. */
const h = vi.hoisted(() => ({
  readContract: vi.fn(),
  builtChains: [] as number[],
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: (opts: { chain: { id: number } }) => {
      h.builtChains.push(opts.chain.id);
      return { readContract: h.readContract };
    },
    http: vi.fn(() => "transport"),
  };
});

import { disposeOriginClients, originBalanceOf } from "./origin-reads";

const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const OWNER = "0x00000000000000000000000000000000000c0a1e" as Address;

describe("originBalanceOf", () => {
  beforeEach(() => {
    disposeOriginClients();
    h.readContract.mockReset();
    h.builtChains.length = 0;
  });

  it("reads a raw balance on a known origin chain", async () => {
    h.readContract.mockResolvedValue(1_000_000_000n); // 1000 USDC
    await expect(originBalanceOf(1, TOKEN, OWNER)).resolves.toBe(1_000_000_000n);
    expect(h.builtChains).toEqual([1]);
  });

  it("refuses a chain outside the origin map with no client built", async () => {
    await expect(originBalanceOf(31_337, TOKEN, OWNER)).resolves.toBeNull();
    expect(h.builtChains).toEqual([]);
    expect(h.readContract).not.toHaveBeenCalled();
  });

  it("reads a failed RPC through as null", async () => {
    h.readContract.mockRejectedValue(new Error("rate limited"));
    await expect(originBalanceOf(8453, TOKEN, OWNER)).resolves.toBeNull();
    expect(h.builtChains).toEqual([8453]);
  });

  it("memoizes one client per origin chain", async () => {
    h.readContract.mockResolvedValue(0n);
    await originBalanceOf(1, TOKEN, OWNER);
    await originBalanceOf(1, TOKEN, OWNER);
    await originBalanceOf(42161, TOKEN, OWNER);
    expect(h.builtChains).toEqual([1, 42161]);
  });
});
