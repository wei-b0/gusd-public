/**
 * Unit tests for the onchain account store — snapshot mapping (cost basis
 * included), refresh dedupe, the stale-address guard, and invalidate.
 * The reads seam is stubbed; nothing touches a chain or the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  balances: vi.fn(),
  positions: vi.fn(),
}));

vi.mock("@/data/web3/reads-protocol", () => ({
  contractReadsWithIndexer: () => ({ balances: h.balances, positions: h.positions }),
}));

vi.mock("@/data/web3/chains", () => ({
  getActiveChain: () => ({ id: 31337 }),
}));

const OWNER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const H100_GPU_ID = "0x483130305f53584d5f3830474200000000000000000000000000000000000000" as const;
const GPU_TOKEN = "0x00000000000000000000000000000000000000dd" as const;

function seedReads(overrides: { balances?: Record<string, number>; positionsBasis?: object } = {}) {
  h.balances.mockResolvedValue({ gUsd: 10, stable: 5, sGusd: 2, ...overrides.balances });
  h.positions.mockResolvedValue([
    {
      gpuId: H100_GPU_ID,
      token: GPU_TOKEN,
      raw: 1_000_000_000_000_000_000n,
      size: 1,
      avgEntryRaw: "2500000",
      realizedPnlGusdRaw: "100000",
      basisState: "complete",
      basisReason: null,
      ...overrides.positionsBasis,
    },
  ]);
}

let store: import("./account-store").OnChainAccountStore;

beforeEach(async () => {
  vi.resetModules();
  seedReads();
  const mod = await import("./account-store");
  store = new mod.OnChainAccountStore();
});

afterEach(() => {
  store.setAddress(null);
  vi.restoreAllMocks();
});

describe("OnChainAccountStore", () => {
  it("starts empty and clears to empty on logout", async () => {
    expect(store.get().address).toBeNull();
    expect(store.get().positions).toEqual([]);
  });

  it("maps balances and positions with cost basis into the snapshot", async () => {
    store.setAddress(OWNER);
    await store.refresh();
    const snap = store.get();
    expect(snap.address).toBe(OWNER);
    expect(snap.chainId).toBe(31337);
    expect(snap.loadedAt).not.toBeNull();
    expect(snap.gUsd).toBe(10);
    expect(snap.sGusd).toBe(2);
    expect(snap.stable).toBe(5);
    expect(snap.positions).toEqual([
      {
        gpuId: H100_GPU_ID,
        asset: "H100",
        token: GPU_TOKEN,
        size: 1,
        avgEntry: 2.5,
        realizedPnl: 0.1,
        basisReason: null,
      },
    ]);
  });

  it("carries gated basis through as null with the reason verbatim", async () => {
    seedReads({
      positionsBasis: {
        avgEntryRaw: null,
        realizedPnlGusdRaw: null,
        basisState: null,
        basisReason: "transfers_missing",
      },
    });
    store.setAddress(OWNER);
    await store.refresh();
    expect(store.get().positions[0]).toMatchObject({
      avgEntry: null,
      realizedPnl: null,
      basisReason: "transfers_missing",
    });
  });

  it("dedupes concurrent refreshes into one reads round", async () => {
    store.setAddress(OWNER);
    await Promise.all([store.refresh(), store.refresh()]);
    expect(h.positions).toHaveBeenCalledTimes(1);
    expect(h.balances).toHaveBeenCalledTimes(1);
  });

  it("drops an in-flight refresh when the session changes underneath it", async () => {
    let resolvePositions: (v: unknown) => void = () => {};
    h.positions.mockReturnValue(
      new Promise((res) => {
        resolvePositions = res;
      }),
    );
    store.setAddress(OWNER);
    store.setAddress(null); // logout while the read is in flight
    resolvePositions([
      {
        gpuId: H100_GPU_ID,
        token: GPU_TOKEN,
        raw: 1n,
        size: 0.000000000000000001,
        avgEntryRaw: null,
        realizedPnlGusdRaw: null,
        basisState: null,
        basisReason: null,
      },
    ]);
    await store.refresh();
    // The stale result must not land: the snapshot stays the empty logout one.
    expect(store.get().address).toBeNull();
    expect(store.get().positions).toEqual([]);
  });

  it("invalidate() re-reads and lands fresh values", async () => {
    store.setAddress(OWNER);
    await store.refresh();
    expect(store.get().gUsd).toBe(10);
    h.balances.mockResolvedValue({ gUsd: 42, stable: 5, sGusd: 2 });
    await store.refresh();
    expect(store.get().gUsd).toBe(42);
  });

  it("keeps the last snapshot when reads fail", async () => {
    store.setAddress(OWNER);
    await store.refresh();
    h.balances.mockRejectedValue(new Error("rpc down"));
    await store.refresh();
    expect(store.get().gUsd).toBe(10);
  });
});
