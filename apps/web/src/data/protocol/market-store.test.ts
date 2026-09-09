/**
 * Unit tests for the protocol market store — asset→pool resolution, tape
 * orientation and mapping, cooldowns, refresh-bypass, fail-soft retention,
 * and the singleton gate. The client is a fake; no network anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProtocolClient } from "./client";

const H100_GPU_ID = "0x483130305f53584d5f3830474200000000000000000000000000000000000000";
const POOL = `0x${"ab".repeat(32)}`;
const GPUTOKEN = "0x00000000000000000000000000000000000000bb";

function gpuBody(canonicalPoolId: string | null = POOL) {
  return {
    gpus: [
      {
        chainId: 31337,
        gpuId: H100_GPU_ID.toUpperCase(), // wire case is not the lookup key
        gpuSku: "H100_SXM_80GB",
        token: GPUTOKEN,
        issuanceFeeBps: 50,
        issuanceEnabled: true,
        poolFee: 3000,
        tickSpacing: 60,
        canonicalPoolId,
        issuedGpu: "0",
        issuedCount: 0,
        issuanceProceedsGusd: "0",
        issuanceFeesGusd: "0",
        principalContributedGusd: "0",
        polGusd: "0",
        polGpu: "0",
        polFeesGusd: "0",
        firstIssuedAtSec: null,
        lastIssuedAtSec: null,
        buyCount: 0,
        sellCount: 0,
        volumeGusd: "0",
        lastTradeAtSec: null,
        catalog: null,
      },
    ],
  };
}

/** One swap, newest-first wire shape. 2 GPU for 5 gUSD, gUSD currency0. */
function swap(blockNumber: number, logIndex = 1) {
  return {
    chainId: 31337,
    blockNumber,
    logIndex,
    blockTimestampSec: 1_700_000_000 + blockNumber,
    poolId: POOL,
    sender: "0x0000000000000000000000000000000000000abc",
    amount0: "5000000",
    amount1: "-2000000000000000000",
    side: "buy" as const,
    gusdAmount: "5000000",
    sqrtPriceX96: "0",
    liquidity: "0",
    tick: 0,
    fee: 3000,
  };
}

function poolRow() {
  return {
    chainId: 31337,
    poolId: POOL,
    gpuId: H100_GPU_ID,
    canonical: true,
    registeredBlockNumber: 1,
    registeredAtSec: 1,
    currency0: "0x00000000000000000000000000000000000000aa",
    currency1: GPUTOKEN,
    fee: 3000,
    tickSpacing: 60,
    hooks: `0x${"11".repeat(20)}`,
    gusdIsCurrency0: true,
    sqrtPriceX96: (2n ** 96n).toString(),
    tick: 0,
    liquidity: "1000000000000",
    swapCount: 3,
    volumeGusd: "15000000",
    buyVolumeGusd: "15000000",
    sellVolumeGusd: "0",
    hookFeesGusd: "0",
    lpFeesGusdEst: "0",
    lastSwapAtSec: null,
    lastSwapBlockNumber: null,
    ammPriceGusd: null,
  };
}

function fakeClient(): ProtocolClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getUserEvents() {
      calls.push("user-events");
      return { events: [] };
    },
    async getWalletBalances() {
      calls.push("balances");
      return { balances: [] };
    },
    async getWalletPositions() {
      calls.push("positions");
      return { positions: [], vault: null };
    },
    async getWalletExecutions() {
      calls.push("executions");
      return { executions: [] };
    },
    async listPools() {
      calls.push("pools");
      return { pools: [poolRow()] };
    },
    async getPoolStats() {
      calls.push("stats");
      return { intervalSec: 3600, buckets: [] };
    },
    async getPoolSwaps(_poolId, query) {
      calls.push(`swaps:${query?.limit ?? "?"}`);
      return { swaps: [swap(103), swap(102), swap(101)] };
    },
    async listGpus() {
      calls.push("gpus");
      return gpuBody();
    },
    async getGpu() {
      calls.push("gpu");
      return null;
    },
    async getStats() {
      calls.push("protocol-stats");
      return { stats: null, vault: null };
    },
    async getOracleState() {
      calls.push("oracle-state");
      return { oracle: null };
    },
  };
}

async function freshStore(client: ProtocolClient) {
  vi.resetModules();
  const mod = await import("./market-store");
  return { mod, store: new mod.ProtocolMarketStore(client, () => 1_700_000_000_000) };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProtocolMarketStore", () => {
  it("resolves the asset's canonical pool from the gpus rows (case-insensitive)", async () => {
    const client = fakeClient();
    const { store } = await freshStore(client);
    expect(store.poolForAsset("H100")).toBeNull(); // nothing yet
    store.tradesFor("H100"); // kicks the gpus fetch
    await vi.waitFor(() => expect(store.poolForAsset("H100")).not.toBeNull());
    expect(store.poolForAsset("H100")?.poolId).toBe(POOL);
  });

  it("serves the tape OLDEST-FIRST and maps rows to MarketTrade", async () => {
    const client = fakeClient();
    const { store } = await freshStore(client);
    let trades = store.tradesFor("H100");
    expect(trades).toHaveLength(0); // nothing yet — the stable empty ref
    await vi.waitFor(() => expect(store.tradesFor("H100")).toHaveLength(3));
    trades = store.tradesFor("H100");
    // wire was newest-first (103,102,101); the port contract is oldest-first
    expect(trades.map((t) => t.id)).toEqual([`${POOL}:101:1`, `${POOL}:102:1`, `${POOL}:103:1`]);
    expect(trades[0]).toMatchObject({ side: "buy", size: 2, notional: 5, price: 2.5 });
  });

  it("returns a stable reference between polls", async () => {
    const client = fakeClient();
    const { store } = await freshStore(client);
    store.tradesFor("H100");
    await vi.waitFor(() => expect(store.tradesFor("H100")).toHaveLength(3));
    const a = store.tradesFor("H100");
    const b = store.tradesFor("H100");
    expect(b).toBe(a);
  });

  it("camps the tape fetch at the ring cap (60)", async () => {
    const client = fakeClient();
    const { store } = await freshStore(client);
    store.tradesFor("H100");
    await vi.waitFor(() => expect(store.poolForAsset("H100")).not.toBeNull());
    store.tradesFor("H100"); // pool now known — this read tracks the tape
    await vi.waitFor(() => expect(client.calls.some((c) => c === "swaps:60")).toBe(true));
  });

  it("cooldowns gate lazy fetches; refresh() bypasses them", async () => {
    const client = fakeClient();
    const { store } = await freshStore(client);
    store.tradesFor("H100");
    await vi.waitFor(() => expect(store.poolForAsset("H100")).not.toBeNull());
    store.volume24hOf("H100"); // ensureHourly #1
    await vi.waitFor(() => expect(client.calls.filter((c) => c === "stats")).toHaveLength(1));
    store.volume24hOf("H100"); // within cooldown — no second fetch
    expect(client.calls.filter((c) => c === "stats")).toHaveLength(1);
    await store.refresh(); // clears the cooldown bookkeeping
    store.volume24hOf("H100"); // now the lazy ensure retries
    expect(client.calls.filter((c) => c === "stats").length).toBeGreaterThanOrEqual(2);
  });

  it("fail-soft: a failing slice keeps its prior value and never throws", async () => {
    const client = fakeClient();
    const { store } = await freshStore(client);
    store.tradesFor("H100");
    await vi.waitFor(() => expect(store.tradesFor("H100")).toHaveLength(3));
    client.getPoolSwaps = async () => {
      throw new Error("down");
    };
    await store.refresh();
    expect(store.tradesFor("H100")).toHaveLength(3); // prior tape kept
    // and the reads stay silent (no throw surfaces)
  });

  it("keeps swaps out of a pool-less asset", async () => {
    const client = fakeClient();
    client.listGpus = async () => gpuBody(null); // no canonical pool
    const { store } = await freshStore(client);
    store.tradesFor("H100");
    await vi.waitFor(() => expect(store.poolForAsset("H100")).toBeNull());
    expect(store.tradesFor("H100")).toHaveLength(0);
    expect(store.volume24hOf("H100")).toBeNull();
    expect(store.liquidityUsdOf("H100")).toBeNull();
    expect(store.trades24hOf("H100")).toBeNull();
  });
});

describe("singleton gate", () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_INDEXER_URL;
  });

  it("is null without the env and rebuilt after dispose", async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_INDEXER_URL;
    const mod = await import("./market-store");
    expect(mod.getProtocolMarketStore()).toBeNull();
    process.env.NEXT_PUBLIC_INDEXER_URL = "http://127.0.0.1:8080/v1/protocol";
    const a = mod.getProtocolMarketStore();
    expect(a).not.toBeNull();
    expect(mod.getProtocolMarketStore()).toBe(a);
    mod.disposeProtocolMarketStore();
    expect(mod.getProtocolMarketStore()).not.toBe(a);
  });
});
