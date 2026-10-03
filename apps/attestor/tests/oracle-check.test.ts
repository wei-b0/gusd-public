import { describe, expect, it } from "vitest";
import { getAddress } from "viem/utils";
import { checkOraclePosture, type OraclePostureInput } from "../src/oracle-check.js";

const RPC = "https://rpc.example.test";

const BASE: OraclePostureInput = {
  rpcUrl: RPC,
  oracleAddress: "0x0000000000000000000000000000000000000a11" as const,
  attestorAddress: "0x0000000000000000000000000000000000000be7" as const,
  chainId: 4663,
  epochLength: 60,
  maxObservationAge: 300,
};

/**
 * A tiny JSON-RPC mock: routes eth_chainId + the three eth_calls by selector
 * position (call order is deterministic — eth_chainId, signer, epochLength,
 * maxObservationAge, resolved together via Promise.all).
 */
function rpcMock(overrides: {
  chainId?: string;
  signer?: string;
  epochLength?: string;
  maxObservationAge?: string;
  error?: { message: string };
}): typeof fetch {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    result: undefined as string | undefined,
    error: overrides.error,
  };
  return (async () =>
    new Response(JSON.stringify(body), {
      status: overrides.error === undefined ? 200 : 400,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/** Pads a 20-byte address / uint to full word hex, like an ABI encoder would. */
const word = (n: bigint | string): string => {
  const hex = typeof n === "string" ? n.slice(2).padStart(64, "0") : n.toString(16).padStart(64, "0");
  return `0x${hex}`;
};

const signerWord = word(BASE.attestorAddress);

// Ordered results for the four calls the check issues.
function orderedRpc(results: { chainId: string; signer: string; epochLength: string; maxObservationAge: string }): typeof fetch {
  const queue = [results.chainId, results.signer, results.epochLength, results.maxObservationAge];
  let i = 0;
  return (async () =>
    new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: queue[Math.min(i++, queue.length - 1)] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

describe("checkOraclePosture", () => {
  it("reports no mismatches when the deployed oracle matches the configured posture", async () => {
    const report = await checkOraclePosture({
      ...BASE,
      fetchImpl: orderedRpc({
        chainId: word(4663n),
        signer: signerWord,
        epochLength: word(60n),
        maxObservationAge: word(300n),
      }),
    });
    expect(report.mismatches).toEqual([]);
    expect(report.onchainSigner.toLowerCase()).toBe(BASE.attestorAddress.toLowerCase());
    expect(report.onchainEpochLength).toBe(60);
    expect(report.onchainMaxObservationAge).toBe(300);
  });

  it("names every drift: wrong signer, chain id, epoch length, observation age", async () => {
    const report = await checkOraclePosture({
      ...BASE,
      fetchImpl: orderedRpc({
        chainId: word(1n),
        signer: word("0x000000000000000000000000000000000000dead"),
        epochLength: word(86400n),
        maxObservationAge: word(86400n),
      }),
    });
    expect(report.mismatches).toHaveLength(4);
    expect(report.mismatches[0]).toContain("chain id 1");
    expect(report.mismatches[1]).toContain("GpuOracle.signer()");
    expect(report.mismatches[1]).toContain("InvalidSignature");
    expect(report.mismatches[2]).toContain("epochLength");
    expect(report.mismatches[3]).toContain("maxObservationAge");
  });

  it("compares the signer case-insensitively (checksummed on-chain vs lowercase config)", async () => {
    // Real RPCs return the EIP-55 checksummed form; the config is lowercase.
    const checksummed = getAddress(BASE.attestorAddress);
    const report = await checkOraclePosture({
      ...BASE,
      fetchImpl: orderedRpc({
        chainId: word(4663n),
        signer: word(checksummed),
        epochLength: word(60n),
        maxObservationAge: word(300n),
      }),
    });
    expect(report.mismatches).toEqual([]);
  });

  it("fails loudly when the eth_call reverts (wrong address, dead RPC)", async () => {
    await expect(
      checkOraclePosture({
        ...BASE,
        fetchImpl: rpcMock({ error: { message: "execution reverted" } }),
      }),
    ).rejects.toThrow(/reverted|HTTP/);
  });
});