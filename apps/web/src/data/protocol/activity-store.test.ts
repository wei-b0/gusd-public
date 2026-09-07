/**
 * Unit tests for the indexed wallet-activity store — load-once semantics,
 * fail-soft slice retention, cursor-chained "Load earlier" with the 5-page
 * cap, wallet-switch mid-flight safety, and the logout clear. The client is
 * a fake; no network anywhere.
 */
import { describe, expect, it, vi } from "vitest";
import type { IndexedEvent } from "@/domain/indexer";
import type { ProtocolClient } from "./client";
import { IndexedActivityStore } from "./activity-store";
import type { ExecutionDto, WalletVaultPositionDto } from "./dto";

const ADDR = "0x00000000000000000000000000000000000000aa";
const ADDR_B = "0x00000000000000000000000000000000000000bb";

function execution(block: number, logIndex = 1): ExecutionDto {
  return {
    side: "buy",
    chainId: 31337,
    blockNumber: block,
    logIndex,
    txHash: `0x${block.toString(16).padStart(64, "0")}`,
    blockTimestampSec: 1_700_000_000 + block,
    gpuId: "0x483130305f53584d5f3830474200000000000000000000000000000000000000",
    wallet: ADDR,
    payer: null,
    gpuAmount: "2000000000000000000",
    gUsdAmount: "5000000",
    poolLegGpu: "1500000000000000000",
    issuanceLegGpu: "500000000000000000",
    issuanceFeeGusd: "10000",
    hookFeeGusd: "0",
  };
}

function event(block: number, logIndex = 1): IndexedEvent {
  return {
    contract: "0x00000000000000000000000000000000000000cc",
    event: "Minted",
    user: ADDR,
    chainId: 31337,
    blockNumber: block,
    logIndex,
    txHash: `0x${block.toString(16).padStart(64, "0")}`,
    seenAtMs: (1_700_000_000 + block) * 1000,
    data: { gusdOut: "10000000" },
  };
}

const VAULT: WalletVaultPositionDto = {
  chainId: 31337,
  shares: "1000000000000000000",
  assetsCost: "5000000",
  basisState: "complete",
  avgEntryAssets: "5000000",
  realizedPnlGusd: "250000",
  reason: null,
  deposits: 2,
  withdraws: 0,
  firstActivityAtSec: 1_700_000_000,
  lastActivityAtSec: 1_700_001_000,
};

/** A client with explicit newest-first pages per stream; each page hands
 *  out its cursor continuation while pages remain. */
function pagingClient(execPages: ExecutionDto[][], eventPages: IndexedEvent[][], vault: WalletVaultPositionDto | null = null) {
  const calls: string[] = [];
  let execI = 0;
  let eventI = 0;
  return {
    calls,
    async getUserEvents(_a: string, query?: { cursor?: string }) {
      calls.push(`events:${query?.cursor ?? "first"}`);
      const page = eventPages[eventI] ?? [];
      eventI += 1;
      return { events: page, nextCursor: eventI < eventPages.length ? `ec${eventI}` : undefined };
    },
    async getWalletBalances() {
      calls.push("balances");
      return { balances: [] };
    },
    async getWalletPositions() {
      calls.push("positions");
      return { positions: [], vault };
    },
    async getWalletExecutions(_a: string, query?: { cursor?: string }) {
      calls.push(`exec:${query?.cursor ?? "first"}`);
      const page = execPages[execI] ?? [];
      execI += 1;
      return { executions: page, nextCursor: execI < execPages.length ? `xc${execI}` : undefined };
    },
    listPools: async () => ({ pools: [] }),
    getPoolStats: async () => ({ intervalSec: 3600, buckets: [] }),
    getPoolSwaps: async () => ({ swaps: [] }),
    listGpus: async () => ({ gpus: [] }),
    getGpu: async () => null,
    getStats: async () => ({ stats: null, vault: null }),
    getOracleState: async () => ({ oracle: null }),
  } as ProtocolClient & { calls: string[] };
}

/** A client whose streams stall until the test releases them. */
function deferredClient() {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = pagingClient([[execution(101)]], [[event(101)]]);
  const slow: ProtocolClient = {
    ...client,
    async getWalletExecutions(a, q) {
      await gate;
      return client.getWalletExecutions(a, q);
    },
    async getUserEvents(a, q) {
      await gate;
      return client.getUserEvents(a, q);
    },
    async getWalletPositions(a) {
      await gate;
      return client.getWalletPositions(a);
    },
  };
  return { client: slow, release: release! };
}

function freshStore(client: ProtocolClient | null) {
  return new IndexedActivityStore(client, () => 1_700_000_000_000);
}

describe("IndexedActivityStore", () => {
  it("loads all three streams on setAddress and lands loadedAt", async () => {
    const client = pagingClient([[execution(101)]], [[event(201)]], VAULT);
    const store = freshStore(client);
    store.setAddress(ADDR);
    await vi.waitFor(() =>
      expect(store.get().executions).toHaveLength(1),
    );
    expect(store.get().events).toHaveLength(1);
    expect(store.get().vaultPosition).toEqual(VAULT);
    expect(store.get().loadedAt).not.toBeNull();
    expect(store.get().loading).toBe(false);
    expect(store.get().hasMoreExecutions).toBe(false);
    expect(store.get().address).toBe(ADDR);
  });

  it("loads once per address: later subscribers don't re-fetch", async () => {
    const client = pagingClient([[execution(101)]], []);
    const store = freshStore(client);
    store.setAddress(ADDR);
    const off1 = store.subscribe(() => {});
    await vi.waitFor(() => expect(store.get().loadedAt).not.toBeNull());
    const calls = client.calls.length;
    const off2 = store.subscribe(() => {});
    off2();
    off1();
    expect(client.calls.length).toBe(calls);
  });

  it("fails soft: a failed slice keeps prior rows; loadedAt only moves when something landed", async () => {
    const client = pagingClient([[execution(101)]], [[event(201)]]);
    // A re-readable executions stream (the paging fake is consumed once).
    client.getWalletExecutions = async () => ({
      executions: [execution(101)],
      nextCursor: undefined,
    });
    const store = freshStore(client);
    store.setAddress(ADDR);
    await vi.waitFor(() => expect(store.get().loadedAt).not.toBeNull());
    const loadedAt = store.get().loadedAt;

    client.getUserEvents = async () => {
      throw new Error("down");
    };
    await store.refresh();
    expect(store.get().events).toHaveLength(1); // prior rows kept
    expect(store.get().executions).toHaveLength(1); // still re-fetched fine
    expect(store.get().loading).toBe(false);
    expect(store.get().loadedAt).toBe(loadedAt); // nothing landed — unchanged
  });

  it("a fully failed load clears loading and keeps state empty", async () => {
    const client = pagingClient([], []);
    client.getWalletExecutions = async () => {
      throw new Error("down");
    };
    client.getUserEvents = async () => {
      throw new Error("down");
    };
    client.getWalletPositions = async () => {
      throw new Error("down");
    };
    const store = freshStore(client);
    store.setAddress(ADDR);
    await vi.waitFor(() => expect(store.get().loading).toBe(false));
    expect(store.get().loadedAt).toBeNull();
    expect(store.get().executions).toHaveLength(0);
  });

  it("is inert without an address — refresh no-ops and touches nothing", async () => {
    const client = pagingClient([[execution(101)]], []);
    const store = freshStore(client);
    await store.refresh();
    expect(client.calls).toHaveLength(0);
    expect(store.get().loadedAt).toBeNull();
  });

  it("is inert without a client — setAddress clears but never fetches", async () => {
    const store = freshStore(null);
    store.setAddress(ADDR);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.get().address).toBe(ADDR);
    expect(store.get().loadedAt).toBeNull();
    expect(store.get().executions).toHaveLength(0);
  });

  it("chains cursors through Load earlier and stops at the 5-page cap", async () => {
    let seed = 300;
    const page = () => Array.from({ length: 6 }, () => execution(seed++));
    const client = pagingClient([page(), page(), page(), page(), page(), page(), page()], []);
    const store = freshStore(client);
    store.setAddress(ADDR);
    await vi.waitFor(() => expect(store.get().executions).toHaveLength(6));
    expect(store.get().hasMoreExecutions).toBe(true);

    await store.loadMoreExecutions();
    await store.loadMoreExecutions();
    await store.loadMoreExecutions();
    await store.loadMoreExecutions();
    await store.loadMoreExecutions();
    expect(store.get().executions).toHaveLength(6 + 5 * 6); // first page + 5 more
    expect(client.calls.filter((c) => c.startsWith("exec:")).length).toBe(6);

    const atCap = store.get().executions.length;
    await store.loadMoreExecutions(); // over the cap — nothing happens
    expect(store.get().executions).toHaveLength(atCap);
    expect(client.calls.filter((c) => c.startsWith("exec:")).length).toBe(6);
  });

  it("loadMore is a no-op when the wire says the stream is done", async () => {
    const client = pagingClient([[execution(101)]], []);
    const store = freshStore(client);
    store.setAddress(ADDR);
    await vi.waitFor(() => expect(store.get().loadedAt).not.toBeNull());
    const calls = client.calls.filter((c) => c.startsWith("exec:")).length;
    await store.loadMoreExecutions();
    expect(client.calls.filter((c) => c.startsWith("exec:")).length).toBe(calls);
  });

  it("a wallet switch mid-flight never applies the old wallet's rows", async () => {
    const { client, release } = deferredClient();
    const store = freshStore(client);
    store.setAddress(ADDR);
    store.setAddress(ADDR_B); // switch before the first pass lands
    release();
    await vi.waitFor(() => expect(store.get().loading).toBe(false));
    expect(store.get().address).toBe(ADDR_B);
    expect(store.get().executions).toHaveLength(0); // A's rows dropped
    expect(store.get().loadedAt).toBeNull(); // B's own load hasn't run
  });

  it("logout clears to the empty state", async () => {
    const client = pagingClient([[execution(101)]], []);
    const store = freshStore(client);
    store.setAddress(ADDR);
    await vi.waitFor(() => expect(store.get().loadedAt).not.toBeNull());
    store.setAddress(null);
    expect(store.get().address).toBeNull();
    expect(store.get().executions).toHaveLength(0);
    expect(store.get().events).toHaveLength(0);
    expect(store.get().vaultPosition).toBeNull();
    expect(store.get().loadedAt).toBeNull();
  });

  it("refresh re-earns the page budget after a full reload", async () => {
    let seed = 300;
    const page = () => Array.from({ length: 6 }, () => execution(seed++));
    const client = pagingClient([page(), page(), page(), page()], []);
    const store = freshStore(client);
    store.setAddress(ADDR);
    await vi.waitFor(() => expect(store.get().executions).toHaveLength(6));
    await store.loadMoreExecutions();
    expect(store.get().executions).toHaveLength(12);
    await store.refresh(); // budget reset, first page again
    expect(store.get().executions).toHaveLength(6);
    await store.loadMoreExecutions(); // and paging still works
    expect(store.get().executions).toHaveLength(12);
  });
});
