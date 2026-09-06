import { describe, expect, it, vi } from "vitest";
import { simulateWrite } from "./simulate";

const ACCOUNT = "0x00000000000000000000000000000000000000ab" as const;

vi.mock("./public-client", () => ({
  getPublicClient: vi.fn(),
}));

import { getPublicClient } from "./public-client";

function mockClient(simulate: () => Promise<unknown>) {
  vi.mocked(getPublicClient).mockReturnValue({
    simulateContract: vi.fn(simulate),
  } as never);
}

describe("simulateWrite", () => {
  it("returns ok when the call executes", async () => {
    mockClient(() => Promise.resolve({ result: 1n }));
    const result = await simulateWrite({
      address: "0x00000000000000000000000000000000000a0001",
      abi: [],
      functionName: "mintUSDC",
      args: [1_000_000n, ACCOUNT],
      account: ACCOUNT,
    });
    expect(result).toEqual({ ok: true });
  });

  it("normalizes a reverting call into product voice", async () => {
    mockClient(() => {
      const reverted = new Error("execution reverted");
      (reverted as unknown as { data: unknown }).data = { errorName: "OracleStale", args: [] };
      return Promise.reject(new Error("simulation failed", { cause: reverted }));
    });
    const result = await simulateWrite({
      address: "0x00000000000000000000000000000000000a0001",
      abi: [],
      functionName: "issue",
      args: [],
      account: ACCOUNT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.voice).toMatch(/stale/i);
  });
});
