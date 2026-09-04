import { describe, expect, it } from "vitest";
import type { Logger } from "@gusd/types";
import { PublisherPoller } from "../src/poller.js";
import type {
  CandidateLike,
  PublishViolation,
  PublishableIndexValue,
  PublisherTarget,
} from "../src/types.js";
import type { PublisherStore } from "../src/store.js";

const NOW = new Date("2026-09-04T12:00:00.000Z");

const CONFIG = {
  pinnedMethodologyVersion: "0.1.0",
  minContributors: 3,
  maxDispersion: 0.45,
  maxFreshnessMs: 300_000,
  maxJumpPct: 0.25,
  maxBandWidthPct: 0.1,
};

function silence(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function healthyCandidate(overrides: Partial<CandidateLike> = {}): CandidateLike {
  return {
    id: "c1",
    gpuId: "H100_SXM_80GB",
    panelId: "H100_PANEL_V1",
    price: 2.94,
    confidenceLow: 2.86,
    confidenceHigh: 3.02,
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
  published: { value: PublishableIndexValue; txRef: string }[] = [];
  violations: { candidateId: string; violations: PublishViolation[] }[] = [];
  private publicationKeys = new Set<string>();
  private violationKeys = new Set<string>();

  constructor(public candidates: CandidateLike[]) {}

  async latestCandidates(): Promise<CandidateLike[]> {
    return this.candidates;
  }

  async latestPublishedPrice(): Promise<number | null> {
    return this.published.length > 0 ? (this.published.at(-1)?.value.price ?? null) : null;
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
    this.published.push({ value, txRef });
    return { inserted: true };
  }

  async recordViolations(
    candidateId: string,
    _gpuId: string,
    target: string,
    violations: readonly PublishViolation[],
  ): Promise<{ inserted: boolean }> {
    const key = `${candidateId}:${target}`;
    if (this.violationKeys.has(key)) return { inserted: false };
    this.violationKeys.add(key);
    this.violations.push({ candidateId, violations: [...violations] });
    return { inserted: true };
  }
}

class FakeTarget implements PublisherTarget {
  readonly name = "mock";
  readonly calls: PublishableIndexValue[] = [];
  async publish(value: PublishableIndexValue): Promise<{ txRef: string }> {
    this.calls.push(value);
    return { txRef: `tx-${this.calls.length}` };
  }
}

function makePoller(
  candidates: CandidateLike[],
  opts: {
    breakers?: () => Promise<ReadonlyMap<string, boolean>>;
    now?: () => Date;
  } = {},
) {
  const store = new FakeStore(candidates);
  const target = new FakeTarget();
  const poller = new PublisherPoller({
    store,
    target,
    config: CONFIG,
    logger: silence(),
    fetchBreakers: opts.breakers,
    now: opts.now ?? (() => NOW),
  });
  return { store, target, poller };
}

describe("PublisherPoller", () => {
  it("publishes a healthy candidate once, then skips it forever", async () => {
    const { target, poller } = makePoller([healthyCandidate()]);
    const first = await poller.tick();
    expect(first.published).toBe(1);
    expect(first.rejected).toBe(0);
    expect(target.calls).toHaveLength(1);
    expect(target.calls[0]?.price).toBe(2.94);

    const second = await poller.tick();
    expect(second.published).toBe(0);
    expect(second.skipped).toBe(1);
    expect(target.calls).toHaveLength(1);
  });

  it("records a rejection with stable codes and never calls the target", async () => {
    const { target, store, poller } = makePoller([
      healthyCandidate({ status: "withheld", price: null }),
    ]);
    const result = await poller.tick();
    expect(result.rejected).toBe(1);
    expect(target.calls).toHaveLength(0);
    const codes = store.violations[0]?.violations.map((v) => v.code) ?? [];
    expect(codes).toContain("not_publishable_status");
    expect(codes).toContain("missing_price");
  });

  it("does not re-record a rejection for the same candidate on the next tick", async () => {
    const { store, poller } = makePoller([healthyCandidate({ status: "stale" })]);
    await poller.tick();
    const second = await poller.tick();
    expect(second.rejected).toBe(0);
    expect(store.violations).toHaveLength(1);
  });

  it("skips the whole cycle when the source health fetch fails", async () => {
    const { target, store, poller } = makePoller([healthyCandidate()], {
      breakers: () => Promise.reject(new Error("oracle down")),
    });
    const result = await poller.tick();
    expect(result).toEqual({ published: 0, rejected: 0, skipped: 0 });
    expect(target.calls).toHaveLength(0);
    expect(store.violations).toHaveLength(0);
    expect(store.published).toHaveLength(0);
  });

  it("passes the breaker map through to validation", async () => {
    // 1 of 2 contributors open is a minority → publishable.
    const minority = makePoller([healthyCandidate()], {
      breakers: () => Promise.resolve(new Map([["vast", true]])),
    });
    const a = await minority.poller.tick();
    expect(a.published).toBe(1);

    // 2 of 2 open is a majority → rejected.
    const majority = makePoller([healthyCandidate()], {
      breakers: () =>
        Promise.resolve(
          new Map([
            ["vast", true],
            ["lium", true],
          ]),
        ),
    });
    const b = await majority.poller.tick();
    expect(b.published).toBe(0);
    expect(b.rejected).toBe(1);
  });

  it("uses the previous published price of the same target as the jump baseline", async () => {
    const { store, target, poller } = makePoller([healthyCandidate()]);
    await poller.tick();
    expect(target.calls).toHaveLength(1);

    // A newer candidate that doubles the price must be rejected against the
    // baseline recorded from the first publish.
    store.candidates = [
      healthyCandidate({ id: "c2", price: 5.0, calcHash: "def" }),
    ];
    const second = await poller.tick();
    expect(second.published).toBe(0);
    expect(second.rejected).toBe(1);
    const codes = store.violations.at(-1)?.violations.map((v) => v.code) ?? [];
    expect(codes).toContain("jump_requires_manual");
  });

  it("survives a store error on one candidate and continues", async () => {
    const store = new FakeStore([healthyCandidate()]);
    const target = new FakeTarget();
    const poller = new PublisherPoller({
      store,
      target,
      config: CONFIG,
      logger: silence(),
      now: () => NOW,
    });
    store.latestPublishedPrice = () => Promise.reject(new Error("db down"));
    const result = await poller.tick();
    expect(result.published).toBe(0);
  });
});
