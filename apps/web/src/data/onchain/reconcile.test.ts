import { describe, expect, it, vi } from "vitest";
import type { IndexerPort } from "@/domain/indexer";
import { INDEXED_EVENT_NAMES } from "@/domain/indexer";
import type { TxPort } from "@/domain/ports";
import type { TxRecord } from "@/domain/types";
import type { OnchainAccountSnapshot } from "./account-store";
import { makeReconciler } from "./reconcile";

/**
 * The reconciler: balances always re-read; indexed evidence only when an
 * indexer stands behind the deployment. Null indexer (today's world) keeps
 * ledgers on "this session" provenance. It never throws.
 */

const OWNER = "0xaaaa00110000000000000000000000000000aaaa";
const CHAIN = 31337;

function snap(address: string | null): OnchainAccountSnapshot {
  return {
    address,
    loadedAt: null,
    chainId: CHAIN,
    gUsd: 0,
    usdc: 0,
    sGusd: 0,
    positions: [],
  };
}

function makeTx(partial: Partial<TxRecord> & { id: string }): TxRecord {
  return {
    hash: null,
    status: "confirmed",
    origin: "mint",
    kind: "mint",
    chainId: CHAIN,
    address: OWNER,
    createdAt: 0,
    updatedAt: 0,
    settledAt: 0,
    blockNumber: null,
    error: null,
    ...partial,
  };
}

interface Harness {
  refresh: ReturnType<typeof vi.fn>;
  earnRefresh: ReturnType<typeof vi.fn>;
  isIndexed: ReturnType<typeof vi.fn>;
  getUserEvents: ReturnType<typeof vi.fn>;
  deps: Parameters<typeof makeReconciler>[0];
}

function makeHarness(options?: {
  indexer?: boolean;
  refreshThrows?: boolean;
  address?: string | null;
}): Harness {
  const refresh = vi.fn(options?.refreshThrows ? () => Promise.reject(new Error("rpc down")) : () => Promise.resolve());
  const earnRefresh = vi.fn(() => Promise.resolve());
  const isIndexed = vi.fn(() => options?.indexer ?? false);
  const getUserEvents = vi.fn(() => Promise.resolve(null));
  const store = {
    refresh,
    get: () => snap(options?.address === undefined ? OWNER : options.address),
  };
  const indexer: IndexerPort = { isIndexed, getUserEvents };
  return {
    refresh,
    earnRefresh,
    isIndexed,
    getUserEvents,
    deps: {
      accountStore: store,
      earn: { refresh: earnRefresh },
      indexer: options?.indexer ? indexer : null,
      tx: {
        get: (id: string) =>
          id === "t1"
            ? makeTx({ id: "t1", hash: "0xH1", blockNumber: 12 })
            : id === "t2"
              ? makeTx({ id: "t2", hash: "0xH2", blockNumber: 10 })
              : null,
      } satisfies Pick<TxPort, "get">,
    },
  };
}

describe("makeReconciler", () => {
  it("re-reads balances and the earn view; indexed stays null without an indexer", async () => {
    const h = makeHarness();
    const reconcile = makeReconciler(h.deps);

    const result = await reconcile(["t1", "t2"]);

    expect(result).toEqual({ balances: true, indexed: null });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.earnRefresh).toHaveBeenCalledTimes(1);
    expect(h.isIndexed).not.toHaveBeenCalled();
  });

  it("never throws when the store re-read fails", async () => {
    const h = makeHarness({ indexer: true, refreshThrows: true });
    const reconcile = makeReconciler(h.deps);

    const result = await reconcile(["t1"]);

    expect(result.balances).toBe(false);
  });

  it("fetches indexed events from the earliest settled block and matches hashes", async () => {
    const h = makeHarness({ indexer: true });
    h.getUserEvents.mockResolvedValue([
      { txHash: "0xH2", event: "Minted" },
      { txHash: "0xOTHER", event: "Buy" },
    ]);
    const reconcile = makeReconciler(h.deps);

    const result = await reconcile(["t1", "t2"]);

    expect(h.isIndexed).toHaveBeenCalledWith(CHAIN);
    expect(h.getUserEvents).toHaveBeenCalledWith(OWNER, {
      fromBlock: 10,
      events: [...INDEXED_EVENT_NAMES],
    });
    // 0xH1's block isn't reflected yet — indexing lag, not failure.
    expect(result).toEqual({ balances: true, indexed: ["0xH2"] });
  });

  it("stays null when the chain has no indexer behind it", async () => {
    const h = makeHarness({ indexer: true });
    h.isIndexed.mockReturnValue(false);
    const reconcile = makeReconciler(h.deps);

    const result = await reconcile(["t1"]);

    expect(result.indexed).toBe(null);
    expect(h.getUserEvents).not.toHaveBeenCalled();
  });

  it("stays null when no transaction settled into a block", async () => {
    const h = makeHarness({ indexer: true });
    h.deps.tx = { get: () => makeTx({ id: "t1", status: "reverted", blockNumber: null }) };
    const reconcile = makeReconciler(h.deps);

    const result = await reconcile(["t1"]);

    expect(result.indexed).toBe(null);
    expect(h.getUserEvents).not.toHaveBeenCalled();
  });

  it("stays null when the indexer hasn't caught up", async () => {
    const h = makeHarness({ indexer: true });
    h.getUserEvents.mockResolvedValue(null);
    const reconcile = makeReconciler(h.deps);

    const result = await reconcile(["t1"]);

    expect(result).toEqual({ balances: true, indexed: null });
  });

  it("skips the indexed half entirely with no session address", async () => {
    const h = makeHarness({ indexer: true, address: null });
    const reconcile = makeReconciler(h.deps);

    const result = await reconcile(["t1"]);

    expect(result.balances).toBe(true);
    expect(result.indexed).toBe(null);
    expect(h.getUserEvents).not.toHaveBeenCalled();
  });
});
