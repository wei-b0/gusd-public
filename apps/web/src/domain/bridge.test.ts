import { describe, expect, it, vi } from "vitest";
import type { BridgeProgress, BridgeQuote } from "./bridge";
import { runBridgeToMint } from "./bridge";

const QUOTE: BridgeQuote = {
  id: "1:0xa:998",
  originChainId: 1,
  inputToken: "0x00000000000000000000000000000000000000a0",
  inputAmount: 1000,
  expectedOutput: 998,
  minOutput: 995,
  originFee: 2,
  etaSeconds: 120,
};

/** Scripted port: yields `stream` then ends. `throwWith` rejects instead. */
function fakeBridge(stream: BridgeProgress[], throwWith: unknown = null) {
  return {
    execute: () =>
      (async function* () {
        if (throwWith !== null) throw throwWith;
        for (const p of stream) yield p;
      })(),
  };
}

function progress(phase: BridgeProgress["phase"], error: string | null = null): BridgeProgress {
  return { phase, message: `msg:${phase}`, txHash: null, error };
}

describe("runBridgeToMint — the funding panel's transition rules", () => {
  it("streams progress yields in order and lands on mint at mint-ready", async () => {
    const onProgress = vi.fn();
    const outcome = await runBridgeToMint(
      fakeBridge([progress("approving"), progress("bridging"), progress("filled"), progress("mint-ready")]),
      QUOTE,
      onProgress,
    );
    expect(outcome).toEqual({ kind: "mint" });
    // mint-ready is the terminal hand-off — it never reaches onProgress
    expect(onProgress.mock.calls.map((c) => (c[0] as BridgeProgress).phase)).toEqual([
      "approving",
      "bridging",
      "filled",
    ]);
  });

  it("returns failed with the port's product voice, and stops early", async () => {
    const onProgress = vi.fn();
    const outcome = await runBridgeToMint(
      fakeBridge([progress("approving"), progress("failed", "allowance refused")]),
      QUOTE,
      onProgress,
    );
    expect(outcome).toEqual({ kind: "failed", error: "allowance refused" });
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it("substitutes a default voice when a failure carries no reason", async () => {
    const outcome = await runBridgeToMint(fakeBridge([progress("failed", null)]), QUOTE, vi.fn());
    expect(outcome).toEqual({ kind: "failed", error: "The bridge failed." });
  });

  it("treats a stream that ends without a terminal as an unconfirmed fill", async () => {
    const outcome = await runBridgeToMint(fakeBridge([progress("bridging")]), QUOTE, vi.fn());
    expect(outcome).toEqual({ kind: "failed", error: "The bridge ended without confirming the fill." });
  });

  it("treats an empty stream the same way", async () => {
    const outcome = await runBridgeToMint(fakeBridge([]), QUOTE, vi.fn());
    expect(outcome).toEqual({ kind: "failed", error: "The bridge ended without confirming the fill." });
  });

  it("propagates a port that throws — the panel catches it", async () => {
    await expect(
      runBridgeToMint(fakeBridge([], new Error("wallet locked")), QUOTE, vi.fn()),
    ).rejects.toThrow("wallet locked");
  });
});
