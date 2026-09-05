import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { Pool } from "pg";
import {
  createDb,
  ensureMethodologyVersion,
  getCandidateById,
  getCurrentMethodology,
  getPublication,
  insertCollectionRun,
  insertIndexCandidate,
  insertProviderPrices,
  insertRawObservations,
  insertNormalizedObservations,
  recordPublication,
  seedProviders,
  type Db,
  type RawRowInput,
} from "../src/index.js";
import { indexCandidates } from "../src/schema/index.js";
import type { ProviderPriceResult } from "@gusd/types";

// DB integration tests are opt-in: RUN_DB_TESTS=1 pnpm --filter @gusd/db test
// (requires `pnpm db:up` + `pnpm db:migrate`).
const run = process.env.RUN_DB_TESTS === "1";
const d = run ? describe : describe.skip;

const DB_URL = process.env.DATABASE_URL ?? "postgres://gusd:gusd@localhost:54329/gusd";
const TEST_DB = "gusd_test";
const TEST_URL = process.env.DATABASE_URL
  ? new URL(DB_URL)
  : new URL("postgres://gusd:gusd@localhost:54329/gusd");

function rawRow(overrides: Partial<RawRowInput["observation"]> = {}): RawRowInput {
  return {
    observation: {
      providerSlug: "vast",
      sourceType: "marketplace",
      rawGpuLabel: "RTX 4090",
      rawPrice: 0.35,
      rawCurrency: "USD",
      rawUnit: "usd_per_gpu_hr",
      gpuCount: 1,
      region: null,
      pricingTier: "on_demand",
      observedAt: new Date("2026-09-04T00:00:00.000Z"),
      sourceUrl: "https://console.vast.ai",
      sourceId: "offer-1",
      rawPayload: { id: 1 },
      ...overrides,
    },
    providerId: "",
    collectionRunId: null,
  };
}

const emptyReceipts: ProviderPriceResult["receipts"] = {
  contributions: [],
  exclusions: [],
  flags: {
    coverageGap: false,
    dedupDroppedCount: 0,
    bidOffersSkipped: 0,
    arithmeticMismatches: 0,
    outOfRangeGpuCounts: 0,
    outOfBandCount: 0,
  },
};

/** Drizzle wraps PG errors ("Failed query: …") with the real error as `.cause`. */
function pgDetail(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur; i++) {
    parts.push(inspect(cur, { depth: 3 }));
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join("\n");
}

async function expectAppendOnlyRejection(p: Promise<unknown>): Promise<void> {
  try {
    await p;
    throw new Error(`expected append-only rejection, but query succeeded`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("expected append-only rejection")) throw err;
    expect(pgDetail(err)).toMatch(/append-only table/);
  }
}

async function expectRejectionWithCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
    throw new Error(`expected rejection with code ${code}, but query succeeded`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("expected rejection with code")) throw err;
    expect(pgDetail(err)).toContain(code);
  }
}

d("db integration (RUN_DB_TESTS=1)", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    // Fresh throwaway database per test run: the append-only triggers make
    // truncate-based cleanup impossible (by design), so tests start from a
    // clean migration instead of mutating guarded tables.
    TEST_URL.pathname = "/postgres";
    const admin = new Pool({ connectionString: TEST_URL.toString() });
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      await admin.query(`CREATE DATABASE ${TEST_DB}`);
    } finally {
      await admin.end();
    }
    TEST_URL.pathname = `/${TEST_DB}`;
    const url = TEST_URL.toString();
    const adminHandle = createDb(url);
    await migrate(adminHandle.db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    await adminHandle.close();

    const handle = createDb(url);
    db = handle.db;
    close = handle.close;
  });

  afterAll(async () => {
    await close();
    TEST_URL.pathname = "/postgres";
    const admin = new Pool({ connectionString: TEST_URL.toString() });
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    } finally {
      await admin.end();
    }
  });

  it("seeds providers idempotently", async () => {
    const seed = {
      slug: "vast",
      name: "Vast.ai",
      sourceType: "marketplace" as const,
      role: "SETTLEMENT_ELIGIBLE" as const,
      cadenceTier: "FAST" as const,
    };
    await seedProviders(db, [seed]);
    await seedProviders(db, [{ ...seed, name: "Vast" }]);
    const rows = await db.execute<{ name: string }>(sql`select name from providers where slug='vast'`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.name).toBe("Vast");
  });

  it("dedups raw observations on obsFingerprint", async () => {
    const provider = await db.execute<{ id: string }>(sql`select id from providers where slug='vast'`);
    const providerId = provider.rows[0]!.id;
    const runId = await insertCollectionRun(db, {
      providerId,
      collectorId: "vast",
      trigger: "replay",
      attempt: 1,
      startedAt: new Date(),
      finishedAt: new Date(),
      durationMs: 5,
      status: "success",
      rawCount: 1,
      normalizedCount: 0,
      unmappedCount: 0,
    });
    const clean: RawRowInput = {
      observation: { ...rawRow().observation },
      providerId,
      collectionRunId: null,
    };
    const first = await insertRawObservations(db, [clean]);
    expect(first).toHaveLength(1);
    const second = await insertRawObservations(db, [clean]);
    expect(second).toHaveLength(0);
    void runId;
  });

  it("append-only triggers raise on UPDATE, DELETE and TRUNCATE", async () => {
    const tables = [
      "raw_observations",
      "normalized_observations",
      "provider_prices",
      "index_candidates",
      "published_index_values",
      "source_failures",
      "fx_rates",
    ];
    for (const t of tables) {
      await expectAppendOnlyRejection(db.execute(sql.raw(`UPDATE ${t} SET id = id`)));
      await expectAppendOnlyRejection(db.execute(sql.raw(`DELETE FROM ${t}`)));
      // CASCADE: a plain TRUNCATE can be refused by FK checks before our
      // trigger runs; with CASCADE the operation lands on referencing tables
      // — all of which are guarded too — and the append-only trigger raises.
      await expectAppendOnlyRejection(db.execute(sql.raw(`TRUNCATE ${t} CASCADE`)));
    }
  });

  it("enforces exactly one current methodology version", async () => {
    await ensureMethodologyVersion(db, {
      version: "0.1.0",
      config: {},
      configHash: "abc",
    });
    await ensureMethodologyVersion(db, { version: "0.1.0", config: {}, configHash: "abc" });
    const current = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from methodology_versions where effective_to is null`,
    );
    expect(current.rows[0]?.n).toBe("1");
    // A different version while still current violates the partial unique index
    // for a raw insert — superseding is only possible through the repo helper.
    await expectRejectionWithCode(
      db.execute(
        sql`insert into methodology_versions (id, version, config, config_hash, effective_from)
            values (gen_random_uuid(), '0.2.0', '{}', 'def', now())`,
      ),
      "methodology_versions_one_current_unique",
    );
    // The repo helper supersedes: 0.2.0 lands, 0.1.0 closes, one open row.
    await ensureMethodologyVersion(db, { version: "0.2.0", config: {}, configHash: "def" });
    const open = await db.execute<{ version: string }>(
      sql`select version from methodology_versions where effective_to is null`,
    );
    expect(open.rows.map((r) => r.version)).toEqual(["0.2.0"]);
    expect((await getCurrentMethodology(db))?.version).toBe("0.2.0");
    // Re-seeding the now-closed 0.1.0 is still an insert-once no-op.
    await ensureMethodologyVersion(db, { version: "0.1.0", config: {}, configHash: "abc" });
    const closed = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from methodology_versions where version = '0.1.0'`,
    );
    expect(closed.rows[0]?.n).toBe("1");
  });

  it("dedups index candidates on (gpuId, calcHash) except stale rows", async () => {
    const base = {
      gpuId: "H100_SXM_80GB",
      panelId: "H100_PANEL_V1",
      price: 2.5,
      confidenceLow: 2.3,
      confidenceHigh: 2.7,
      dispersion: 0.1,
      status: "healthy" as const,
      providersObserved: 5,
      providersContributing: 4,
      methodologyVersion: "0.1.0",
      gates: [],
      contributors: [],
      exclusions: [],
      calcParams: {},
      calcHash: "hash-1",
      windowStart: new Date("2026-09-04T00:00:00Z"),
      windowEnd: new Date("2026-09-04T00:30:00Z"),
      computedAt: new Date("2026-09-04T00:30:00Z"),
    };
    const first = await insertIndexCandidate(db, base);
    expect(first.inserted).toBe(true);
    const dupe = await insertIndexCandidate(db, base);
    expect(dupe.inserted).toBe(false);
    expect(dupe.id).toBe(first.id);
    const byId = await getCandidateById(db, first.id);
    expect(byId?.price).toBe(2.5);
    // stale rows bypass the partial unique index (carry-forward may repeat)
    const stale = await insertIndexCandidate(db, { ...base, status: "stale", price: 2.4 });
    expect(stale.inserted).toBe(true);
    const stale2 = await insertIndexCandidate(db, { ...base, status: "stale", price: 2.4 });
    expect(stale2.inserted).toBe(true);
  });

  it("records publications idempotently", async () => {
    const candidates = await db.select().from(indexCandidates).limit(1);
    const candidate = candidates[0]!;
    const pub = {
      candidateId: candidate.id,
      gpuId: candidate.gpuId,
      panelId: candidate.panelId,
      price: 2.5,
      confidenceLow: 2.3,
      confidenceHigh: 2.7,
      status: "healthy" as const,
      publisherVersion: "0.1.0",
      target: "mock",
      txRef: "0xdeadbeef",
      publishedAt: new Date(),
    };
    expect((await recordPublication(db, pub)).inserted).toBe(true);
    expect((await recordPublication(db, pub)).inserted).toBe(false);
    const existing = await getPublication(db, pub.candidateId, pub.target);
    expect(existing?.txRef).toBe("0xdeadbeef");
  });

  it("stores provider prices with receipts", async () => {
    const provider = await db.execute<{ id: string }>(sql`select id from providers where slug='vast'`);
    await insertProviderPrices(db, [
      {
        providerId: provider.rows[0]!.id,
        gpuId: "H100_SXM_80GB",
        panelId: "H100_PANEL_V1",
        price: 2.4,
        method: "volume_weighted_median",
        executable: true,
        sampleSize: 12,
        windowStart: new Date(),
        windowEnd: new Date(),
        computedAt: new Date(),
        methodologyVersion: "0.1.0",
        params: {},
        receipts: emptyReceipts,
      },
    ]);
    const rows = await db.execute<{ price: string; receipts: unknown }>(
      sql`select price, receipts from provider_prices limit 1`,
    );
    expect(rows.rows[0]?.price).toBe("2.4000");
    expect(rows.rows[0]?.receipts).toMatchObject({ contributions: [] });
  });

  it("upserts unmapped labels with occurrence counts", async () => {
    const provider = await db.execute<{ id: string }>(sql`select id from providers where slug='vast'`);
    const providerId = provider.rows[0]!.id;
    const { upsertUnmappedLabels } = await import("../src/index.js");
    await upsertUnmappedLabels(db, [
      { providerId, rawGpuLabel: "H800 PCIE", sampleRawObservationId: null, lastSeenAt: new Date() },
    ]);
    await upsertUnmappedLabels(db, [
      { providerId, rawGpuLabel: "H800 PCIE", sampleRawObservationId: null, lastSeenAt: new Date() },
    ]);
    const rows = await db.execute<{ occurrences: number }>(
      sql`select occurrences from unmapped_labels where raw_gpu_label='H800 PCIE'`,
    );
    expect(Number(rows.rows[0]?.occurrences)).toBe(2);
  });

  it("inserts normalized observations idempotently", async () => {
    const raws = await db.execute<{ id: string }>(sql`select id from raw_observations limit 1`);
    const rawId = raws.rows[0]!.id;
    const provider = await db.execute<{ id: string }>(sql`select id from providers where slug='vast'`);
    const { insertNormalizedObservations } = await import("../src/index.js");
    const row = {
      rawObservationId: rawId,
      providerId: provider.rows[0]!.id,
      sourceType: "marketplace" as const,
      gpuId: "RTX_4090_24GB",
      usdPerGpuHour: 0.35,
      pricingTier: "on_demand" as const,
      gpuCount: 1,
      region: null,
      available: true,
      offerId: "offer-1",
      machineId: "m1",
      hostId: "h1",
      rawTotalUsdPerHour: null,
      isBid: false,
      fxRateUsed: null,
      fxRateDate: null,
      normalizationVersion: "v1",
      observedAt: new Date(),
    };
    await insertNormalizedObservations(db, [row]);
    await insertNormalizedObservations(db, [row]); // conflict on rawObservationId → no-op
    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text n from normalized_observations where raw_observation_id = ${rawId}`,
    );
    expect(rows.rows[0]?.n).toBe("1");
  });

  it("allows mutations on non-append-only tables", async () => {
    // providers and methodology_versions are versioned registry state, not
    // facts — they stay mutable.
    await expect(db.execute(sql`update providers set updated_at = updated_at`)).resolves.toBeDefined();
    await expect(
      db.execute(sql`update methodology_versions set config = config`),
    ).resolves.toBeDefined();
  });
});
