/**
 * Unit tests for the indexed read seam — mapping of /v1/protocol/* payloads
 * onto the ContractReads port, chain filtering, and the RPC fallback on any
 * indexed failure. Network-free: fetch and the RPC reads are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

const h = vi.hoisted(() => ({
  indexerUrl: null as string | null,
  fetchCalls: [] as string[],
  fetchResponder: ((url: string) => {
    void url;
    throw new Error("no responder");
  }) as (url: string) => { status: number; body: unknown },
  rpcCalls: [] as string[],
  stableBalance: 1_500_000n as bigint,
  gusdPaused: false,
  convertToAssets: 1_000_000n as bigint,
  convertToAssetsError: null as Error | null,
  seeded: true,
}));

vi.mock("./chains", () => ({
  getActiveChain: () => ({ id: 31337 }),
}));

vi.mock("./contracts", () => ({
  getContracts: () => ({
    gusd: {
      read: {
        paused: async () => {
          h.rpcCalls.push("gusd.paused");
          return h.gusdPaused;
        },
      },
    },
    sgusd: {
      read: {
        convertToAssets: async () => {
          h.rpcCalls.push("sgusd.convertToAssets");
          if (h.convertToAssetsError !== null) throw h.convertToAssetsError;
          return h.convertToAssets;
        },
        seeded: async () => {
          h.rpcCalls.push("sgusd.seeded");
          return h.seeded;
        },
        maxDeposit: async () => {
          h.rpcCalls.push("sgusd.maxDeposit");
          return 2n ** 256n - 1n;
        },
        maxWithdraw: async () => {
          h.rpcCalls.push("sgusd.maxWithdraw");
          return 5_000_000n;
        },
      },
    },
    stable: {
      read: {
        balanceOf: async () => {
          h.rpcCalls.push("stable.balanceOf");
          return h.stableBalance;
        },
      },
    },
    addresses: {
      gusd: "0x00000000000000000000000000000000000000aa",
      sgusd: "0x00000000000000000000000000000000000000bb",
      underlying: "0x00000000000000000000000000000000000000cc",
    },
  }),
}));

vi.mock("./reads", () => ({
  contractReads: () => ({
    balances: async (owner: Address) => {
      h.rpcCalls.push(`rpc.balances:${owner}`);
      return { gUsd: -1, stable: -1, sGusd: -1 };
    },
    positions: async (owner: Address) => {
      h.rpcCalls.push(`rpc.positions:${owner}`);
      return [];
    },
    registration: async (gpuId: string) => {
      h.rpcCalls.push(`rpc.registration:${gpuId}`);
      return null;
    },
    gusdState: async () => {
      h.rpcCalls.push("rpc.gusdState");
      return { mintFeeBps: 99, redeemFeeBps: 99, paused: true };
    },
    sgusdState: async (owner: Address) => {
      h.rpcCalls.push(`rpc.sgusdState:${owner}`);
      return { rate: -1, seeded: false, maxDeposit: 0n, maxWithdraw: 0n };
    },
    hookFeeBps: async () => {
      h.rpcCalls.push("rpc.hookFeeBps");
      return 999;
    },
  }),
}));

globalThis.fetch = (async (input: RequestInfo | URL) =>
  h.fetchResponder(String(input))) as typeof fetch;

const OWNER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
const GUSD = "0x00000000000000000000000000000000000000aa";
const SGUSD = "0x00000000000000000000000000000000000000bb";
const GPU_TOKEN = "0x540c0d76372a169834c60ebcbf47cda873b84193";
const H100_GPU_ID =
  "0x483130305f53584d5f3830474200000000000000000000000000000000000000";
const CANONICAL_POOL = `0x${"ab".repeat(32)}`;

function json(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

let reads: typeof import("./reads-protocol");

beforeEach(async () => {
  h.indexerUrl = "http://127.0.0.1:8080/v1/protocol";
  h.rpcCalls = [];
  h.fetchCalls = [];
  h.gusdPaused = false;
  h.seeded = true;
  h.fetchResponder = () => {
    throw new Error("no responder");
  };
  vi.resetModules();
  process.env.NEXT_PUBLIC_INDEXER_URL = "http://127.0.0.1:8080/v1/protocol";
  reads = await import("./reads-protocol");
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_INDEXER_URL;
});

describe("contractReadsWithIndexer — inert without env", () => {
  it("returns the pure RPC implementation when the env is absent", async () => {
    process.env.NEXT_PUBLIC_INDEXER_URL = "";
    const r = reads.contractReadsWithIndexer();
    await r.gusdState();
    expect(h.rpcCalls).toContain("rpc.gusdState");
    expect(h.fetchCalls).toHaveLength(0);
  });
});

describe("balances", () => {
  it("maps indexed gusd/sgusd balances and keeps stable on RPC", async () => {
    h.fetchResponder = (url) => {
      h.fetchCalls.push(url);
      if (url.endsWith(`/wallets/${OWNER.toLowerCase()}/balances`)) {
        return json(200, {
          balances: [
            { chainId: 31337, token: GUSD, balance: "1100000", transferCount: 2, lastTransferAtSec: 1, lastTransferBlockNumber: 1 },
            { chainId: 31337, token: SGUSD, balance: "500000", transferCount: 1, lastTransferAtSec: 1, lastTransferBlockNumber: 1 },
            { chainId: 999, token: GUSD, balance: "777777", transferCount: 1, lastTransferAtSec: 1, lastTransferBlockNumber: 1 },
          ],
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    const r = reads.contractReadsWithIndexer();
    const out = await r.balances(OWNER);
    expect(out).toEqual({ gUsd: 1.1, stable: 1.5, sGusd: 0.5 });
    // The other chain's row must not leak in.
    expect(h.rpcCalls).toEqual(["stable.balanceOf"]);
  });

  it("falls back to the full RPC read when the indexer is unreachable", async () => {
    h.fetchResponder = () => {
      throw new Error("ECONNREFUSED");
    };
    const r = reads.contractReadsWithIndexer();
    const out = await r.balances(OWNER);
    expect(out).toEqual({ gUsd: -1, stable: -1, sGusd: -1 });
    expect(h.rpcCalls).toContain(`rpc.balances:${OWNER}`);
  });
});

describe("positions", () => {
  it("derives raw positions from gpu assets × indexed balances", async () => {
    h.fetchResponder = (url) => {
      h.fetchCalls.push(url);
      if (url.endsWith("/gpus")) {
        return json(200, {
          gpus: [
            { gpuId: H100_GPU_ID, token: GPU_TOKEN, canonicalPoolId: CANONICAL_POOL, issuanceEnabled: true, poolFee: 3000, tickSpacing: 60, issuanceFeeBps: 50 },
            { gpuId: `0x${"ff".repeat(32)}`, token: "0x00000000000000000000000000000000000000ff", canonicalPoolId: null, issuanceEnabled: true, poolFee: 3000, tickSpacing: 60, issuanceFeeBps: 50 },
          ],
        });
      }
      if (url.endsWith(`/wallets/${OWNER.toLowerCase()}/balances`)) {
        return json(200, {
          balances: [
            { chainId: 31337, token: GPU_TOKEN.toLowerCase(), balance: "2000000000000000000", transferCount: 1, lastTransferAtSec: 1, lastTransferBlockNumber: 1 },
          ],
        });
      }
      if (url.endsWith(`/wallets/${OWNER.toLowerCase()}/positions`)) {
        return json(200, { positions: [], vault: null });
      }
      throw new Error(`unexpected ${url}`);
    };
    const r = reads.contractReadsWithIndexer();
    const out = await r.positions(OWNER);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ gpuId: H100_GPU_ID, token: GPU_TOKEN, raw: 2_000_000_000_000_000_000n, size: 2 });
  });

  it("attaches the indexed basis by gpuId (case-insensitive, chain-filtered)", async () => {
    h.fetchResponder = (url) => {
      if (url.endsWith("/gpus")) {
        return json(200, {
          gpus: [
            { gpuId: H100_GPU_ID, token: GPU_TOKEN, canonicalPoolId: CANONICAL_POOL, issuanceEnabled: true, poolFee: 3000, tickSpacing: 60, issuanceFeeBps: 50 },
          ],
        });
      }
      if (url.endsWith(`/wallets/${OWNER.toLowerCase()}/balances`)) {
        return json(200, {
          balances: [
            { chainId: 31337, token: GPU_TOKEN.toLowerCase(), balance: "2000000000000000000", transferCount: 1, lastTransferAtSec: 1, lastTransferBlockNumber: 1 },
          ],
        });
      }
      if (url.endsWith(`/wallets/${OWNER.toLowerCase()}/positions`)) {
        return json(200, {
          positions: [
            {
              chainId: 31337,
              gpuId: H100_GPU_ID.toUpperCase(), // joins case-insensitively
              qtyGpu: "2000000000000000000",
              costGusd: "5000000",
              basisState: "complete",
              avgEntryGusd: "2500000",
              realizedPnlGusd: "150000",
              reason: null,
              acquisitions: 2,
              disposals: 0,
              firstActivityAtSec: 1,
              lastActivityAtSec: 2,
            },
            {
              chainId: 999, // another chain — must not leak in
              gpuId: H100_GPU_ID,
              qtyGpu: "1",
              costGusd: "1",
              basisState: "complete",
              avgEntryGusd: "1",
              realizedPnlGusd: "1",
              reason: null,
              acquisitions: 1,
              disposals: 0,
              firstActivityAtSec: 1,
              lastActivityAtSec: 1,
            },
          ],
          vault: null,
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    const r = reads.contractReadsWithIndexer();
    const out = await r.positions(OWNER);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      avgEntryRaw: "2500000",
      realizedPnlGusdRaw: "150000",
      basisState: "complete",
      basisReason: null,
    });
  });

  it("degrades to balance-derived with null basis when /positions answers 404", async () => {
    h.fetchResponder = (url) => {
      if (url.endsWith("/gpus")) {
        return json(200, {
          gpus: [
            { gpuId: H100_GPU_ID, token: GPU_TOKEN, canonicalPoolId: CANONICAL_POOL, issuanceEnabled: true, poolFee: 3000, tickSpacing: 60, issuanceFeeBps: 50 },
          ],
        });
      }
      if (url.endsWith(`/wallets/${OWNER.toLowerCase()}/balances`)) {
        return json(200, {
          balances: [
            { chainId: 31337, token: GPU_TOKEN.toLowerCase(), balance: "1000000000000000000", transferCount: 1, lastTransferAtSec: 1, lastTransferBlockNumber: 1 },
          ],
        });
      }
      return json(404, { error: "not indexed yet" });
    };
    const r = reads.contractReadsWithIndexer();
    const out = await r.positions(OWNER);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ size: 1, avgEntryRaw: null, realizedPnlGusdRaw: null, basisReason: null });
    expect(h.rpcCalls).not.toContain(`rpc.positions:${OWNER}`);
  });

  it("falls back to RPC when /gpus fails", async () => {
    h.fetchResponder = () => {
      throw new Error("boom");
    };
    const r = reads.contractReadsWithIndexer();
    await r.positions(OWNER);
    expect(h.rpcCalls).toContain(`rpc.positions:${OWNER}`);
  });
});

describe("registration", () => {
  it("maps the gpu asset + registered pool row", async () => {
    h.fetchResponder = (url) => {
      h.fetchCalls.push(url);
      if (url.endsWith(`/gpus/${H100_GPU_ID}`)) {
        return json(200, {
          gpu: { gpuId: H100_GPU_ID, token: GPU_TOKEN, canonicalPoolId: CANONICAL_POOL, issuanceEnabled: true, poolFee: 3000, tickSpacing: 60, issuanceFeeBps: 50 },
        });
      }
      if (url.includes("/pools/")) {
        return json(200, { pool: {} });
      }
      throw new Error(`unexpected ${url}`);
    };
    const r = reads.contractReadsWithIndexer();
    const out = await r.registration(H100_GPU_ID as `0x${string}`);
    expect(out).toEqual({
      gpuId: H100_GPU_ID,
      token: GPU_TOKEN,
      issuanceEnabled: true,
      poolRegistered: true,
      poolParams: { fee: 3000, tickSpacing: 60 },
      issuanceFeeBps: 50,
    });
  });

  it("answers null for an unregistered gpu (404 is data, not failure)", async () => {
    h.fetchResponder = () => json(404, { error: "no such gpu" });
    const r = reads.contractReadsWithIndexer();
    const out = await r.registration(H100_GPU_ID as `0x${string}`);
    expect(out).toBeNull();
    expect(h.rpcCalls).toHaveLength(0);
  });

  it("reports poolRegistered false when no canonical pool row exists", async () => {
    h.fetchResponder = (url) => {
      if (url.endsWith(`/gpus/${H100_GPU_ID}`)) {
        return json(200, {
          gpu: { gpuId: H100_GPU_ID, token: GPU_TOKEN, canonicalPoolId: null, issuanceEnabled: false, poolFee: 3000, tickSpacing: 60, issuanceFeeBps: 50 },
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    const r = reads.contractReadsWithIndexer();
    const out = await r.registration(H100_GPU_ID as `0x${string}`);
    expect(out?.poolRegistered).toBe(false);
    expect(out?.issuanceEnabled).toBe(false);
  });
});

describe("gusdState", () => {
  it("takes fees from the index, pause stays a direct read", async () => {
    h.fetchResponder = () => json(200, { stats: { mintFeeBps: 25, redeemFeeBps: 30, hookFeeBps: 50 }, vault: null });
    h.gusdPaused = true;
    const r = reads.contractReadsWithIndexer();
    const out = await r.gusdState();
    expect(out).toEqual({ mintFeeBps: 25, redeemFeeBps: 30, paused: true });
    expect(h.rpcCalls).toEqual(["gusd.paused"]);
  });

  it("falls back to RPC when the config mirror is unpublished", async () => {
    h.fetchResponder = () => json(200, { stats: { mintFeeBps: null, redeemFeeBps: null, hookFeeBps: 50 }, vault: null });
    const r = reads.contractReadsWithIndexer();
    await r.gusdState();
    expect(h.rpcCalls).toContain("rpc.gusdState");
  });
});

describe("sgusdState", () => {
  it("prices the share on-chain — convertToAssets(1e6) is primary", async () => {
    // The rate is execution-adjacent (it prices stake/unstake), so it rides
    // the RPC; the vault mirror backs it only when the direct read fails.
    // Caps stay direct reads either way.
    h.fetchResponder = () =>
      json(200, {
        stats: { mintFeeBps: 0, redeemFeeBps: 0, hookFeeBps: 50 },
        vault: {
          seededGusd: "1000000",
          depositsGusd: "500000",
          withdrawsGusd: "0",
          sharesMinted: "1500000",
          sharesBurned: "500000",
          revenueGusd: "25000",
        },
      });
    h.convertToAssets = 1_525_000n; // the aggregate WOULD also derive 1.525 — RPC wins
    const r = reads.contractReadsWithIndexer();
    const out = await r.sgusdState(OWNER);
    expect(out.rate).toBe(1.525);
    expect(h.rpcCalls).toContain("sgusd.convertToAssets");
    expect(h.rpcCalls).toContain("sgusd.maxDeposit");
    expect(h.rpcCalls).toContain("sgusd.maxWithdraw");
  });

  it("derives the rate from vault aggregates when the RPC read fails", async () => {
    // sgUSD shares are 6-dec (1:1 genesis, same as the gUSD asset), so all
    // six vault aggregates are raw6 and the per-1-sgUSD rate is
    // (10^6 × assets) / shares, both sides raw6.
    // assets = 1.0 seeded + 0.5 deposits − 0 withdraws + 0.025 revenue
    //        = 1_525_000 raw6; shares = 1.5 minted − 0.5 burned = 1_000_000
    // rate   = 10^6 × 1_525_000 / 1_000_000 = 1_525_000 raw6 = 1.525 gUSD.
    h.fetchResponder = () =>
      json(200, {
        stats: { mintFeeBps: 0, redeemFeeBps: 0, hookFeeBps: 50 },
        vault: {
          seededGusd: "1000000",
          depositsGusd: "500000",
          withdrawsGusd: "0",
          sharesMinted: "1500000",
          sharesBurned: "500000",
          revenueGusd: "25000",
        },
      });
    h.convertToAssetsError = new Error("rpc down");
    const r = reads.contractReadsWithIndexer();
    const out = await r.sgusdState(OWNER);
    expect(out.rate).toBe(1.525);
    expect(h.rpcCalls).toContain("sgusd.convertToAssets"); // tried, failed
    expect(h.rpcCalls).toContain("sgusd.maxDeposit");
  });

  it("falls back to RPC when the vault has zero shares and the RPC read fails", async () => {
    h.fetchResponder = () =>
      json(200, {
        stats: { mintFeeBps: 0, redeemFeeBps: 0, hookFeeBps: 50 },
        vault: {
          seededGusd: "0",
          depositsGusd: "0",
          withdrawsGusd: "0",
          sharesMinted: "0",
          sharesBurned: "0",
          revenueGusd: "0",
        },
      });
    h.convertToAssetsError = new Error("rpc down");
    const r = reads.contractReadsWithIndexer();
    await r.sgusdState(OWNER);
    expect(h.rpcCalls).toContain(`rpc.sgusdState:${OWNER}`);
  });

  it("falls back to RPC when the vault mirror is unpublished", async () => {
    h.fetchResponder = () => json(200, { stats: { mintFeeBps: 0, redeemFeeBps: 0, hookFeeBps: 50 }, vault: null });
    const r = reads.contractReadsWithIndexer();
    await r.sgusdState(OWNER);
    expect(h.rpcCalls).toContain(`rpc.sgusdState:${OWNER}`);
  });
});

describe("hookFeeBps", () => {
  it("comes from the index and falls back to RPC on failure", async () => {
    h.fetchResponder = () => json(200, { stats: { mintFeeBps: 0, redeemFeeBps: 0, hookFeeBps: 50 }, vault: null });
    const r = reads.contractReadsWithIndexer();
    expect(await r.hookFeeBps()).toBe(50);

    h.fetchResponder = () => {
      throw new Error("down");
    };
    expect(await r.hookFeeBps()).toBe(999);
    expect(h.rpcCalls).toContain("rpc.hookFeeBps");
  });
});
