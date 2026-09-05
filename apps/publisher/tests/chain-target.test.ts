import { describe, expect, it } from "vitest";
import type { Logger } from "@gusd/types";
import { DEFAULT_METHODOLOGY_CONFIG, type MethodologyConfig } from "@gusd/pricing-engine";
import { ChainPublisherTarget, type ChainClient } from "../src/chain-target.js";
import { encodeGpuId, PRICE_SCALE } from "../src/encoding.js";
import { PublisherPoller } from "../src/poller.js";
import { parsePublisherEnv } from "../src/env.js";
import type {
  CandidateLike,
  PublishViolation,
  PublishableIndexValue,
} from "../src/types.js";
import type { PublisherStore } from "../src/store.js";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ORACLE = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

/** Controllable fake: records sendPublish calls, replays configured values. */
function fakeClient(overrides: Partial<ChainClient> = {}): ChainClient & {
  calls: { gpuId: string; price: bigint; updatedAt: number }[];
} {
  const calls: { gpuId: string; price: bigint; updatedAt: number }[] = [];
  return {
    calls,
    chainId: async () => 31337n,
    priceScale: async () => PRICE_SCALE,
    publisher: async () => ACCOUNT as `0x${string}`,
    sendPublish: async (gpuId, price, updatedAt) => {
      calls.push({ gpuId, price, updatedAt });
      return { txHash: "0xdeadbeef" };
    },
    ...overrides,
  };
}

function target(client: ChainClient = fakeClient()): ChainPublisherTarget {
  return new ChainPublisherTarget(client, {
    accountAddress: ACCOUNT,
    expectedChainId: 31337,
  });
}

function publishable(overrides: Partial<PublishableIndexValue> = {}): PublishableIndexValue {
  return {
    candidateId: "c1",
    gpuId: "H100_SXM_80GB",
    panelId: "H100_PANEL_V1",
    price: 2.5001,
    confidenceLow: null,
    confidenceHigh: null,
    status: "healthy",
    methodologyVersion: "0.1.0",
    calcHash: "abc",
    computedAt: "2026-09-04T11:59:50.000Z",
    ...overrides,
  };
}

describe("ChainPublisherTarget.verify", () => {
  it("passes when chain id, PRICE_SCALE, and publisher identity all match", async () => {
    await expect(target().verify()).resolves.toBeUndefined();
  });

  it("aborts on a chain-id mismatch", async () => {
    const client = fakeClient({ chainId: async () => 1n });
    await expect(target(client).verify()).rejects.toThrow(/chain id mismatch.*connected to 1/);
  });

  it("aborts on a PRICE_SCALE mismatch", async () => {
    const client = fakeClient({ priceScale: async () => 1000n });
    await expect(target(client).verify()).rejects.toThrow(/PRICE_SCALE is 1000/);
  });

  it("aborts when the process does not sign from the oracle's publisher", async () => {
    const client = fakeClient({
      publisher: async () => "0x0000000000000000000000000000000000000001" as `0x${string}`,
    });
    await expect(target(client).verify()).rejects.toThrow(/publisher is.*signs from/);
  });

  it("compares publisher identity case-insensitively", async () => {
    const client = fakeClient({
      publisher: async () => ACCOUNT.toLowerCase() as `0x${string}`,
    });
    await expect(target(client).verify()).resolves.toBeUndefined();
  });
});

describe("ChainPublisherTarget.publish", () => {
  it("encodes the value into the oracle's wire format and returns the tx hash", async () => {
    const client = fakeClient();
    const result = await target(client).publish(publishable());
    expect(result).toEqual({ txRef: "0xdeadbeef" });
    expect(client.calls).toEqual([
      {
        gpuId: encodeGpuId("H100_SXM_80GB"),
        price: 25_001n, // 2.5001 through the float-safe scaler
        updatedAt: Date.parse("2026-09-04T11:59:50.000Z") / 1000,
      },
    ]);
  });

  it("throws on an unencodable value without any chain traffic", async () => {
    const client = fakeClient();
    await expect(
      target(client).publish(publishable({ gpuId: "H100 SXM" })), // space: not printable ASCII
    ).rejects.toThrow(/not printable ASCII/);
    await expect(
      target(client).publish(publishable({ price: 0 })),
    ).rejects.toThrow(/positive finite/);
    expect(client.calls).toEqual([]);
  });
});

// ------------------------------------------------------ env gate (fail-closed)

describe("parsePublisherEnv target gate", () => {
  const CHAIN_ENV = {
    PUBLISHER_TARGET: "chain",
    PUBLISHER_RPC_URL: "http://127.0.0.1:8545",
    PUBLISHER_PRIVATE_KEY: `0x${"ab".repeat(32)}`,
    PUBLISHER_ORACLE_ADDRESS: ORACLE,
    PUBLISHER_CHAIN_ID: "31337",
  };

  it("defaults to the mock target", () => {
    expect(parsePublisherEnv({}).target).toBe("mock");
  });

  it("refuses an unknown target at parse time", () => {
    expect(() => parsePublisherEnv({ PUBLISHER_TARGET: "mainnet" })).toThrow(
      /PUBLISHER_TARGET must be "mock" or "chain"/,
    );
  });

  it("accepts a fully-configured chain target", () => {
    const env = parsePublisherEnv(CHAIN_ENV);
    expect(env.target).toBe("chain");
    expect(env.chainId).toBe(31337);
    expect(env.txTimeoutMs).toBe(120_000);
  });

  it("requires each chain variable", () => {
    for (const missing of [
      "PUBLISHER_RPC_URL",
      "PUBLISHER_PRIVATE_KEY",
      "PUBLISHER_ORACLE_ADDRESS",
      "PUBLISHER_CHAIN_ID",
    ]) {
      const partial = { ...CHAIN_ENV } as Record<string, string>;
      delete partial[missing];
      expect(() => parsePublisherEnv(partial)).toThrow(new RegExp(missing));
    }
  });

  it("refuses a malformed private key or oracle address", () => {
    expect(() =>
      parsePublisherEnv({ ...CHAIN_ENV, PUBLISHER_PRIVATE_KEY: "0x1234" }),
    ).toThrow(/32-byte hex private key/);
    expect(() =>
      parsePublisherEnv({ ...CHAIN_ENV, PUBLISHER_ORACLE_ADDRESS: "0x1234" }),
    ).toThrow(/20-byte hex address/);
  });

  it("mock target carries null chain fields", () => {
    const env = parsePublisherEnv({});
    expect(env.rpcUrl).toBeNull();
    expect(env.privateKey).toBeNull();
  });
});

// ------------------------------------------ poller integration (full tick path)

function silence(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

const CONFIG = {
  pinnedMethodologyVersion: "0.1.0",
  minContributors: 3,
  maxDispersion: 0.45,
  maxFreshnessMs: 300_000,
  maxJumpPct: 0.25,
  maxBandWidthPct: 0.1,
};

function healthyCandidate(overrides: Partial<CandidateLike> = {}): CandidateLike {
  return {
    id: "c1",
    gpuId: "H100_SXM_80GB",
    panelId: "H100_PANEL_V1",
    price: 2.5001,
    confidenceLow: 2.45,
    confidenceHigh: 2.55,
    status: "healthy",
    providersContributing: 4,
    dispersion: 0.02,
    methodologyVersion: "0.1.0",
    calcHash: "abc",
    computedAt: new Date(NOW.getTime() - 10_000),
    contributors: [{ providerId: "vast" }, { providerId: "lium" }],
    ...overrides,
  };
}

/** In-memory store with the same (candidateId, target) idempotency as the DB. */
class FakeStore implements PublisherStore {
  published: { value: PublishableIndexValue; txRef: string; target: string }[] = [];
  violationRows: { candidateId: string; target: string; violations: PublishViolation[] }[] = [];
  private publicationKeys = new Set<string>();
  private violationKeys = new Set<string>();

  constructor(public candidates: CandidateLike[]) {}

  async latestCandidates(): Promise<CandidateLike[]> {
    return this.candidates;
  }

  async methodologyConfig(): Promise<MethodologyConfig | null> {
    return DEFAULT_METHODOLOGY_CONFIG;
  }

  async latestPublishedPrice(): Promise<number | null> {
    return this.published.at(-1)?.value.price ?? null;
  }

  async alreadyPublished(candidateId: string, target: string): Promise<boolean> {
    return this.publicationKeys.has(`${candidateId}:${target}`);
  }

  async recordPublication(
    value: PublishableIndexValue,
    txRef: string,
    target: string,
  ): Promise<{ inserted: boolean }> {
    const key = `${value.candidateId}:${target}`;
    if (this.publicationKeys.has(key)) return { inserted: false };
    this.publicationKeys.add(key);
    this.published.push({ value, txRef, target });
    return { inserted: true };
  }

  async recordViolations(
    candidateId: string,
    _gpuId: string,
    target: string,
    violations: PublishViolation[],
  ): Promise<{ inserted: boolean }> {
    const key = `${candidateId}:${target}`;
    if (this.violationKeys.has(key)) return { inserted: false };
    this.violationKeys.add(key);
    this.violationRows.push({ candidateId, target, violations });
    return { inserted: true };
  }
}

describe("chain target through the poller", () => {
  it("publishes a healthy candidate on-chain and records it under target=chain", async () => {
    const client = fakeClient();
    const store = new FakeStore([healthyCandidate()]);
    const poller = new PublisherPoller({
      store,
      target: target(client),
      config: CONFIG,
      logger: silence(),
      now: () => NOW,
    });
    const counters = await poller.tick();
    expect(counters.published).toBe(1);
    expect(store.published).toEqual([
      {
        value: expect.objectContaining({ candidateId: "c1", gpuId: "H100_SXM_80GB" }),
        txRef: "0xdeadbeef",
        target: "chain",
      },
    ]);
    expect(client.calls).toHaveLength(1);
    const [call] = client.calls;
    expect(call?.price).toBe(25_001n);
  });

  it("does not re-publish the same candidate (idempotent per target)", async () => {
    const client = fakeClient();
    const store = new FakeStore([healthyCandidate()]);
    const poller = new PublisherPoller({
      store,
      target: target(client),
      config: CONFIG,
      logger: silence(),
      now: () => NOW,
    });
    await poller.tick();
    const counters = await poller.tick();
    expect(counters).toEqual({ published: 0, rejected: 0, skipped: 1 });
    expect(client.calls).toHaveLength(1);
  });

  it("survives a reverting publish — no ledger row, other candidates continue", async () => {
    // the oracle rejects H100 specifically (simulated revert); H200 goes through
    const client = fakeClient({
      sendPublish: async (gpuId, price, updatedAt) => {
        if (gpuId === encodeGpuId("H100_SXM_80GB")) {
          throw new Error("execution reverted: NotPublisher()");
        }
        client.calls.push({ gpuId, price, updatedAt });
        return { txHash: "0xbeef" };
      },
    });
    const store = new FakeStore([
      healthyCandidate({ id: "c1", gpuId: "H100_SXM_80GB" }),
      healthyCandidate({ id: "c2", gpuId: "H200_141GB", price: 3.1 }),
    ]);
    const poller = new PublisherPoller({
      store,
      target: target(client),
      config: CONFIG,
      logger: silence(),
      now: () => NOW,
    });
    const counters = await poller.tick();
    expect(counters.published).toBe(1);
    // H100 left no ledger row; H200 published normally and the loop continued
    expect(store.published).toEqual([
      { value: expect.objectContaining({ gpuId: "H200_141GB" }), txRef: "0xbeef", target: "chain" },
    ]);
  });
});
