import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, getCandidateHistory, migrateDb, insertIndexCandidate, type Db } from "@gusd/db";
import type { Logger } from "@gusd/types";
import { DrizzlePublisherStore } from "../src/store.js";
import { MockPublisherTarget } from "../src/target.js";
import { PublisherPoller } from "../src/poller.js";
import type { PublisherConfig } from "../src/types.js";

/**
 * Publisher against the real schema (opt-in): RUN_DB_TESTS=1 pnpm --filter @gusd/publisher test
 * (requires `pnpm db:up`). Verifies the Drizzle store reads, the append-only
 * publication ledger, and violation idempotency on the real tables.
 */
const run = process.env.RUN_DB_TESTS === "1";
const d = run ? describe : describe.skip;

const BASE = "postgres://gusd:gusd@localhost:54329";
const TEST_DB = "gusd_publisher_test";
const TEST_URL = new URL(`${BASE}/postgres`);
const NOW = new Date("2026-09-04T12:00:00.000Z");

const CONFIG: PublisherConfig = {
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

const CONTRIBUTOR_SLUGS = ["vast", "lium", "hyperbolic", "runpod"];

async function seedCandidate(
  db: Db,
  candidate: {
    gpuId: string;
    panelId: string;
    price: number | null;
    status: "healthy" | "withheld";
    calcHash: string;
  },
): Promise<string> {
  const inserted = await insertIndexCandidate(db, {
    gpuId: candidate.gpuId,
    panelId: candidate.panelId,
    price: candidate.price,
    confidenceLow: candidate.price === null ? null : candidate.price * 0.97,
    confidenceHigh: candidate.price === null ? null : candidate.price * 1.03,
    dispersion: 0.02,
    status: candidate.status,
    providersObserved: 4,
    providersContributing: 4,
    methodologyVersion: "0.1.0",
    gates: [],
    contributors: CONTRIBUTOR_SLUGS.map((providerId) => ({
      providerId,
      price: candidate.price ?? 0,
      weightBeforeCap: 1,
      weightAfterCap: 0.25,
      executable: true,
      sampleSize: 8,
      method: "volume_weighted_median",
      sigma: 0,
    })),
    exclusions: [],
    calcParams: { config: {}, priceSource: "computed" },
    calcHash: candidate.calcHash,
    windowStart: new Date(NOW.getTime() - 60_000),
    windowEnd: NOW,
    computedAt: NOW,
    priorCandidateId: null,
  });
  if (!inserted.inserted) throw new Error(`candidate ${candidate.calcHash} not inserted`);
  return inserted.id;
}

d("publisher over the real schema (RUN_DB_TESTS=1)", () => {
  let handle: ReturnType<typeof createDb>;

  beforeAll(async () => {
    TEST_URL.pathname = "/postgres";
    const admin = createDb(TEST_URL.toString());
    try {
      await admin.db.execute(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      await admin.db.execute(`CREATE DATABASE ${TEST_DB}`);
    } finally {
      await admin.close();
    }
    TEST_URL.pathname = `/${TEST_DB}`;
    const adminHandle = createDb(TEST_URL.toString());
    await migrateDb(adminHandle);
    await adminHandle.close();

    handle = createDb(TEST_URL.toString());
    await seedCandidate(handle.db, {
      gpuId: "H100_SXM_80GB",
      panelId: "H100_PANEL_V1",
      price: 2.94,
      status: "healthy",
      calcHash: "hash-healthy",
    });
    await seedCandidate(handle.db, {
      gpuId: "H200_141GB",
      panelId: "H200_PANEL_V1",
      price: 3.4,
      status: "withheld",
      calcHash: "hash-withheld",
    });
  });

  afterAll(async () => {
    await handle.close();
    TEST_URL.pathname = "/postgres";
    const admin = createDb(TEST_URL.toString());
    try {
      await admin.db.execute(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    } finally {
      await admin.close();
    }
  });

  it("publishes the healthy candidate once and the ledger records it", async () => {
    const store = new DrizzlePublisherStore(handle.db, ["H100_SXM_80GB"]);
    const target = new MockPublisherTarget();
    const poller = new PublisherPoller({
      store,
      target,
      config: CONFIG,
      logger: silence(),
      now: () => NOW,
    });

    const first = await poller.tick();
    expect(first.published).toBe(1);
    expect(target.published).toHaveLength(1);

    // Second tick: already published → skipped, no duplicate ledger row.
    const second = await poller.tick();
    expect(second.skipped).toBe(1);
    expect(target.published).toHaveLength(1);

    const rows = await handle.db.execute<{ c: string }>(
      `select count(*) c from published_index_values where target = 'mock'`,
    );
    expect(Number(rows.rows[0]?.c)).toBe(1);
  });

  it("records a withheld candidate's violations exactly once", async () => {
    const store = new DrizzlePublisherStore(handle.db, ["H200_141GB"]);
    const target = new MockPublisherTarget();
    const poller = new PublisherPoller({
      store,
      target,
      config: CONFIG,
      logger: silence(),
      now: () => NOW,
    });

    await poller.tick();
    await poller.tick();
    expect(target.published).toHaveLength(0);

    const counts = await handle.db.execute<{ c: string }>(
      `select count(*) c from publish_violations where gpu_id = 'H200_141GB'`,
    );
    expect(Number(counts.rows[0]?.c)).toBe(1);
    const latest = await handle.db.execute<{ violations: { code: string }[] }>(
      `select violations from publish_violations where gpu_id = 'H200_141GB' limit 1`,
    );
    const violations = latest.rows[0]?.violations ?? [];
    expect(violations.map((v) => v.code)).toContain("not_publishable_status");
  });

  it("reads the latest candidate newest-first through the store", async () => {
    const candidates = await new DrizzlePublisherStore(handle.db, [
      "H100_SXM_80GB",
      "H200_141GB",
    ]).latestCandidates();
    expect(candidates).toHaveLength(2);
    const byGpu = new Map(candidates.map((c) => [c.gpuId, c]));
    expect(byGpu.get("H100_SXM_80GB")?.price).toBe(2.94);
    expect(byGpu.get("H200_141GB")?.status).toBe("withheld");
  });
});
