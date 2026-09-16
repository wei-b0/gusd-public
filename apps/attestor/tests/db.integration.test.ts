import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import {
  createDb,
  ensureMethodologyVersion,
  insertIndexCandidate,
  type Db,
} from "@gusd/db";
import { migrateDb } from "@gusd/db/migrate";
import { DEFAULT_METHODOLOGY_CONFIG } from "@gusd/pricing-engine";
import { canonicalJson, type Logger } from "@gusd/types";
import type { GpuOracleDomain } from "@gusd/attestor-client";
import { DrizzleAttestorStore } from "../src/store.js";
import { AttestorPoller } from "../src/poller.js";
import type { AttestorConfig } from "../src/types.js";

/**
 * Attestor against the real schema (opt-in): RUN_DB_TESTS=1 pnpm --filter @gusd/attestor test
 * (requires `pnpm stack:up`). Verifies the Drizzle store reads, the
 * one-report-per-(gpu_id, epoch) ledger, and violation idempotency on the
 * real tables.
 */
const run = process.env.RUN_DB_TESTS === "1";
const d = run ? describe : describe.skip;

const BASE = "postgres://gusd:gusd@localhost:54329";
const TEST_DB = "gusd_attestor_test";
const TEST_URL = new URL(`${BASE}/postgres`);
const NOW = new Date(1_789_500_000_000);
const EPOCH_LENGTH = 60;
const MAX_OBSERVATION_AGE = 300;

const DOMAIN: GpuOracleDomain = {
  chainId: 31337,
  verifyingContract: "0x0000000000000000000000000000000000010cc0",
};
// anvil #0 — public dev key, never operational
const ATTESTOR_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const CONFIG: AttestorConfig = {
  pinnedMethodologyVersion: "0.4.0",
  minContributors: null,
  maxDispersion: null,
  maxFreshnessMs: 300_000,
  maxJumpPct: 0.25,
  maxBandWidthPct: null,
};

function silence(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

const CONTRIBUTOR_SLUGS = ["vast", "lium", "hyperbolic", "runpod"];

/** sha256 of a stable string — valid 64-hex calcHashes the Report can carry. */
function hashOf(tag: string): string {
  return `0x${createHash("sha256").update(tag).digest("hex")}`;
}

async function seedCandidate(
  db: Db,
  candidate: {
    gpuId: string;
    panelId: string;
    price: number | null;
    status: "healthy" | "degraded" | "withheld";
    calcHash: string;
    contributors?: string[];
  },
): Promise<string> {
  const contributorSlugs = candidate.contributors ?? CONTRIBUTOR_SLUGS;
  const inserted = await insertIndexCandidate(db, {
    gpuId: candidate.gpuId,
    panelId: candidate.panelId,
    price: candidate.price,
    confidenceLow: candidate.price === null ? null : candidate.price * 0.97,
    confidenceHigh: candidate.price === null ? null : candidate.price * 1.03,
    dispersion: 0.02,
    status: candidate.status,
    providersObserved: contributorSlugs.length,
    providersContributing: contributorSlugs.length,
    methodologyVersion: "0.4.0",
    gates: [],
    contributors: contributorSlugs.map((providerId) => ({
      providerId,
      price: candidate.price ?? 0,
      weightBeforeCap: 1,
      weightAfterCap: 1 / contributorSlugs.length,
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

d("attestor over the real schema (RUN_DB_TESTS=1)", () => {
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
    await ensureMethodologyVersion(handle.db, {
      version: "0.4.0",
      config: DEFAULT_METHODOLOGY_CONFIG as unknown as Record<string, unknown>,
      configHash: createHash("sha256")
        .update(canonicalJson(DEFAULT_METHODOLOGY_CONFIG))
        .digest("hex"),
    });
    await seedCandidate(handle.db, {
      gpuId: "H100_SXM_80GB",
      panelId: "H100_PANEL_V1",
      price: 2.94,
      status: "healthy",
      calcHash: hashOf("hash-healthy"),
    });
    await seedCandidate(handle.db, {
      gpuId: "H200_141GB",
      panelId: "H200_PANEL_V1",
      price: 3.4,
      status: "withheld",
      calcHash: hashOf("hash-withheld"),
    });
    await seedCandidate(handle.db, {
      gpuId: "L40S_48GB",
      panelId: "L40S_PANEL_V1",
      price: 0.62,
      status: "degraded",
      calcHash: hashOf("hash-l40s"),
      contributors: ["datacrunch", "scaleway", "coreweave"],
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

  it("attests the healthy candidate once; the (gpu_id, epoch) key blocks re-attestation", async () => {
    const store = new DrizzleAttestorStore(handle.db, ["H100_SXM_80GB"]);
    const poller = new AttestorPoller({
      store,
      signer: privateKeyToAccount(ATTESTOR_PK),
      domain: DOMAIN,
      config: CONFIG,
      epochLength: EPOCH_LENGTH,
      maxObservationAge: MAX_OBSERVATION_AGE,
      logger: silence(),
      now: () => NOW,
    });

    const first = await poller.tick();
    expect(first.attested).toBe(1);

    // Second tick: same epoch → skipped, no duplicate report row.
    const second = await poller.tick();
    expect(second.skipped).toBe(1);

    const rows = await handle.db.execute<{ c: string }>(
      `select count(*) c from reports where gpu_id = 'H100_SXM_80GB'`,
    );
    expect(Number(rows.rows[0]?.c)).toBe(1);
  });

  it("persists the report exactly as it is signed (scaled price, bounds, signature)", async () => {
    const store = new DrizzleAttestorStore(handle.db, ["L40S_48GB"]);
    const poller = new AttestorPoller({
      store,
      signer: privateKeyToAccount(ATTESTOR_PK),
      domain: DOMAIN,
      config: CONFIG,
      epochLength: EPOCH_LENGTH,
      maxObservationAge: MAX_OBSERVATION_AGE,
      logger: silence(),
      now: () => NOW,
    });
    const result = await poller.tick();
    expect(result.attested).toBe(1);

    const rows = await handle.db.execute<{
      price: string;
      epoch: string;
      valid_from: string;
      valid_until: string;
      calc_hash: string;
      signature: string;
      report_hash: string;
    }>(`select price, epoch, valid_from, valid_until, calc_hash, signature, report_hash
         from reports where gpu_id = 'L40S_48GB'`);
    const row = rows.rows[0];
    expect(row).toBeDefined();
    expect(Number(row!.price)).toBe(6_200); // 0.62 × PRICE_SCALE
    expect(Number(row!.validUntil) - Number(row!.validFrom)).toBe(EPOCH_LENGTH);
    expect(row!.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(row!.calc_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(row!.report_hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("attests a flagged candidate and records its audit annotation once", async () => {
    // Liveness-first: a withheld status is an audit annotation, not a blocker —
    // a numeric price attests regardless, and the annotation rides the report
    // as one publish_violations row (never duplicated on a re-tick).
    const store = new DrizzleAttestorStore(handle.db, ["H200_141GB"]);
    const poller = new AttestorPoller({
      store,
      signer: privateKeyToAccount(ATTESTOR_PK),
      domain: DOMAIN,
      config: CONFIG,
      epochLength: EPOCH_LENGTH,
      maxObservationAge: MAX_OBSERVATION_AGE,
      logger: silence(),
      now: () => NOW,
    });

    const first = await poller.tick();
    expect(first.attested).toBe(1);
    expect(first.flagged).toBe(1);

    const counts = await handle.db.execute<{ c: string }>(
      `select count(*) c from publish_violations where gpu_id = 'H200_141GB'`,
    );
    expect(Number(counts.rows[0]?.c)).toBe(1);
    const latest = await handle.db.execute<{ violations: { code: string }[] }>(
      `select violations from publish_violations where gpu_id = 'H200_141GB' limit 1`,
    );
    const violations = latest.rows[0]?.violations ?? [];
    expect(violations.map((v) => v.code)).toContain("not_publishable_status");

    // Second tick: already attested this epoch → skipped, no duplicate row.
    const second = await poller.tick();
    expect(second.skipped).toBe(1);
    const recount = await handle.db.execute<{ c: string }>(
      `select count(*) c from publish_violations where gpu_id = 'H200_141GB'`,
    );
    expect(Number(recount.rows[0]?.c)).toBe(1);
  });

  it("reads the latest candidate newest-first through the store", async () => {
    const candidates = await new DrizzleAttestorStore(handle.db, [
      "H100_SXM_80GB",
      "H200_141GB",
    ]).latestCandidates();
    expect(candidates).toHaveLength(2);
    const byGpu = new Map(candidates.map((c) => [c.gpuId, c]));
    expect(byGpu.get("H100_SXM_80GB")?.price).toBe(2.94);
    expect(byGpu.get("H200_141GB")?.status).toBe("withheld");
  });
});
