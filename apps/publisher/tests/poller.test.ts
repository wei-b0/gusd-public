import { describe, expect, it } from "vitest";
import type { Logger } from "@gusd/types";
import { DEFAULT_METHODOLOGY_CONFIG, type MethodologyConfig } from "@gusd/pricing-engine";
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
  pinnedMethodologyVersion: "0.2.0",
  minContributors: null,
  maxDispersion: null,
  maxFreshnessMs: 300_000,
  maxJumpPct: 0.25,
  maxBandWidthPct: null,
  minDeviationPct: 0.5,
  heartbeatMs: 86_400_000,
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
    methodologyVersion: "0.2.0",
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
  methodology: MethodologyConfig | null = DEFAULT_METHODOLOGY_CONFIG;
  private publicationKeys = new Set<string>();
  private violationKeys = new Set<string>();
  private lastPublishedAt: Date = NOW;

  constructor(public candidates: CandidateLike[]) {}

  async latestCandidates(): Promise<CandidateLike[]> {
    return this.candidates;
  }

  async methodologyConfig(): Promise<MethodologyConfig | null> {
    return this.methodology;
  }

  async latestPublication(): Promise<{ price: number; publishedAt: Date } | null> {
    const last = this.published.at(-1);
    return last ? { price: last.value.price, publishedAt: this.lastPublishedAt } : null;
  }

  async alreadyPublished(candidateId: string, target: string): Promise<boolean> {
    return this.publicationKeys.has(`${candidateId}:${target}`);
  }

  async recordPublication(
    value: PublishableIndexValue,
    txRef: string,
    target: string,
    _publisherVersion?: string,
    publishedAt?: Date,
  ): Promise<{ inserted: boolean }> {
    const key = `${value.candidateId}:${target}`;
    if (this.publicationKeys.has(key)) return { inserted: false };
    this.publicationKeys.add(key);
    this.published.push({ value, txRef });
    this.lastPublishedAt = publishedAt ?? NOW;
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
    expect(first.flagged).toBe(0);
    expect(target.calls).toHaveLength(1);
    expect(target.calls[0]?.price).toBe(2.94);

    const second = await poller.tick();
    expect(second.published).toBe(0);
    expect(second.skipped).toBe(1);
    expect(target.calls).toHaveLength(1);
  });

  it("does not publish a priceless candidate and records the audit row", async () => {
    const { target, store, poller } = makePoller([
      healthyCandidate({ status: "withheld", price: null, confidenceLow: null, confidenceHigh: null }),
    ]);
    const result = await poller.tick();
    expect(result.published).toBe(0);
    expect(result.flagged).toBe(0);
    expect(target.calls).toHaveLength(0);
    // The refusal is still audited.
    const codes = store.violations[0]?.violations.map((v) => v.code) ?? [];
    expect(codes).toContain("not_publishable_status");
    expect(codes).toContain("missing_price");
  });

  it("publishes a flagged candidate anyway and keeps the audit row", async () => {
    // Thin quorum + withheld status: annotated, and the price still ships.
    const { store, target, poller } = makePoller([
      healthyCandidate({ status: "withheld", providersContributing: 2 }),
    ]);
    const result = await poller.tick();
    expect(result.published).toBe(1);
    expect(result.flagged).toBe(1);
    expect(target.calls).toHaveLength(1);
    const codes = store.violations[0]?.violations.map((v) => v.code) ?? [];
    expect(codes).toContain("not_publishable_status");
    expect(codes).toContain("insufficient_contributors");
  });

  it("does not re-record annotations for the same candidate on the next tick", async () => {
    const { store, poller } = makePoller([healthyCandidate({ status: "stale" })]);
    await poller.tick();
    const second = await poller.tick();
    expect(second.flagged).toBe(0);
    expect(store.violations).toHaveLength(1);
  });

  it("records no annotations for suppressed candidates — the audit ledger rides publications", async () => {
    // A withheld candidate inside the deviation band never publishes, so it
    // never writes a publish_violations row either; suppressed wobbles must
    // not flood the append-only ledger.
    const { store, target, poller } = makePoller([healthyCandidate()]);
    await poller.tick();
    store.candidates = [
      healthyCandidate({ id: "c2", status: "withheld", price: 2.941, calcHash: "def" }),
    ];
    const second = await poller.tick();
    expect(second.published).toBe(0);
    expect(second.flagged).toBe(0);
    expect(store.violations).toHaveLength(0);
    expect(target.calls).toHaveLength(1);
  });

  it("skips the whole cycle when the source health fetch fails", async () => {
    const { target, store, poller } = makePoller([healthyCandidate()], {
      breakers: () => Promise.reject(new Error("oracle down")),
    });
    const result = await poller.tick();
    expect(result).toEqual({ published: 0, flagged: 0, skipped: 0 });
    expect(target.calls).toHaveLength(0);
    expect(store.violations).toHaveLength(0);
    expect(store.published).toHaveLength(0);
  });

  it("refuses the whole cycle when the pinned methodology row is missing", async () => {
    const { target, store, poller } = makePoller([healthyCandidate()]);
    store.methodology = null;
    const result = await poller.tick();
    expect(result).toEqual({ published: 0, flagged: 0, skipped: 0 });
    expect(target.calls).toHaveLength(0);
    expect(store.violations).toHaveLength(0);
  });

  it("publishes a thin panel on its per-panel quorum from the methodology", async () => {
    // GB200's override settles on a single rate-card source; the methodology
    // row says quorum 1, so one contributor is not even an annotation.
    const { target, poller } = makePoller([
      healthyCandidate({
        gpuId: "GB200_192GB",
        panelId: "GB200_PANEL_V1",
        price: 16,
        confidenceLow: 15.52,
        confidenceHigh: 16.48,
        status: "degraded",
        providersContributing: 1,
        contributors: [{ providerId: "oracle-oci" }],
      }),
    ]);
    const result = await poller.tick();
    expect(result.published).toBe(1);
    expect(result.flagged).toBe(0);
    expect(target.calls[0]?.price).toBe(16);
  });

  it("an explicit env contributor floor tightens the annotation, not the publication", async () => {
    const store = new FakeStore([
      healthyCandidate({
        gpuId: "GB200_192GB",
        panelId: "GB200_PANEL_V1",
        price: 16,
        confidenceLow: 15.52,
        confidenceHigh: 16.48,
        status: "degraded",
        providersContributing: 1,
        contributors: [{ providerId: "oracle-oci" }],
      }),
    ]);
    const target = new FakeTarget();
    const poller = new PublisherPoller({
      store,
      target,
      config: { ...CONFIG, minContributors: 3 },
      logger: silence(),
      now: () => NOW,
    });
    const result = await poller.tick();
    expect(result.published).toBe(1);
    expect(result.flagged).toBe(1);
    const codes = store.violations[0]?.violations.map((v) => v.code) ?? [];
    expect(codes).toContain("insufficient_contributors");
  });

  it("passes the breaker map through to the audit", async () => {
    // 1 of 2 contributors open is a minority → no annotation.
    const minority = makePoller([healthyCandidate()], {
      breakers: () => Promise.resolve(new Map([["vast", true]])),
    });
    const a = await minority.poller.tick();
    expect(a.published).toBe(1);
    expect(a.flagged).toBe(0);

    // 2 of 2 open is a majority → annotated, published anyway.
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
    expect(b.published).toBe(1);
    expect(b.flagged).toBe(1);
  });

  it("annotates a jump against the last published price but still publishes it", async () => {
    const { store, target, poller } = makePoller([healthyCandidate()]);
    await poller.tick();
    expect(target.calls).toHaveLength(1);

    // A newer candidate that doubles the price: annotated for manual review,
    // and shipped — a 2× market move is exactly when swaps need the new price.
    store.candidates = [healthyCandidate({ id: "c2", price: 5.0, calcHash: "def" })];
    const second = await poller.tick();
    expect(second.published).toBe(1);
    expect(second.flagged).toBe(1);
    const codes = store.violations.at(-1)?.violations.map((v) => v.code) ?? [];
    expect(codes).toContain("jump_requires_manual");
    expect(target.calls[1]?.price).toBe(5.0);
  });

  it("suppresses the tx while the candidate stays within the deviation band", async () => {
    const { store, target, poller } = makePoller([healthyCandidate()]);
    await poller.tick();
    expect(target.calls).toHaveLength(1);

    // +0.034% — inside the §11 0.5% band. The on-chain figure is already
    // current; burning gas would change nothing.
    store.candidates = [healthyCandidate({ id: "c2", price: 2.941, calcHash: "def" })];
    const second = await poller.tick();
    expect(second.published).toBe(0);
    expect(second.skipped).toBe(1);
    expect(target.calls).toHaveLength(1);
  });

  it("publishes once the candidate diverges past the deviation band", async () => {
    const { store, target, poller } = makePoller([healthyCandidate()]);
    await poller.tick();

    // +0.68% — beyond 0.5%.
    store.candidates = [healthyCandidate({ id: "c2", price: 2.96, calcHash: "def" })];
    const second = await poller.tick();
    expect(second.published).toBe(1);
    expect(target.calls[1]?.price).toBe(2.96);
  });

  it("republishes at the heartbeat even without deviation", async () => {
    let nowMs = NOW.getTime();
    const { store, target, poller } = makePoller([healthyCandidate()], {
      now: () => new Date(nowMs),
    });
    await poller.tick();
    expect(target.calls).toHaveLength(1);

    // 25h later, same price: the heartbeat keeps on-chain updatedAt fresh.
    nowMs += 25 * 3_600_000;
    store.candidates = [healthyCandidate({ id: "c2", price: 2.94, calcHash: "def" })];
    const second = await poller.tick();
    expect(second.published).toBe(1);
    expect(target.calls).toHaveLength(2);
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
    store.latestPublication = () => Promise.reject(new Error("db down"));
    const result = await poller.tick();
    expect(result.published).toBe(0);
  });
});
