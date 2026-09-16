import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import type { GpuOracleDomain, SignedReport } from "@gusd/attestor-client";
import {
  buildReport,
  reportHash,
  reportTypedData,
} from "@gusd/attestor-client";
import type { Logger } from "@gusd/types";
import { AttestorPoller } from "../src/poller.js";
import type { AttestorStore } from "../src/store.js";
import type { AttestorConfig, CandidateLike, PublishViolation } from "../src/types.js";

const DOMAIN: GpuOracleDomain = {
  chainId: 31337,
  verifyingContract: "0x0000000000000000000000000000000000010cc0",
};
// anvil #0 — a public dev key for reproducible fixtures; NEVER operational
const ATTESTOR_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const signer = privateKeyToAccount(ATTESTOR_PK);

const NOW = new Date(1_789_500_000_000); // a fixed instant, aligned to no epoch boundary
const EPOCH_LENGTH = 60;
const MAX_OBSERVATION_AGE = 300;

const CONFIG: AttestorConfig = {
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

const CALC_HASH = "0x" + "ab".repeat(32);

function candidate(overrides: Partial<CandidateLike> = {}): CandidateLike {
  return {
    id: "c1",
    gpuId: "H100_SXM_80GB",
    panelId: "H100_PANEL_V1",
    price: 2.5,
    confidenceLow: 2.45,
    confidenceHigh: 2.55,
    status: "healthy",
    providersContributing: 4,
    dispersion: 0.02,
    methodologyVersion: "0.1.0",
    calcHash: CALC_HASH,
    computedAt: new Date(NOW.getTime() - 10_000),
    contributors: [
      { providerId: "vast" },
      { providerId: "lium" },
      { providerId: "hyperbolic" },
      { providerId: "runpod" },
    ],
    ...overrides,
  };
}

interface ReportRow {
  version: number;
  gpuId: string;
  candidateId: string | null;
  price: number;
  observedAt: number;
  epoch: number;
  validFrom: number;
  validUntil: number;
  calcHash: string;
  signature: string;
  reportHash: string;
  attestedAt: Date;
}

function memoryStore(candidates: CandidateLike[]): AttestorStore & {
  rows: ReportRow[];
  violations: { candidateId: string; violations: PublishViolation[] }[];
  failCandidates: boolean;
} {
  return {
    rows: [],
    violations: [],
    failCandidates: false,
    async latestCandidates() {
      if (this.failCandidates) throw new Error("db down");
      return candidates;
    },
    async methodologyConfig(version) {
      return version === "0.1.0"
        ? ({ version: "0.1.0" } as unknown as Awaited<
            ReturnType<AttestorStore["methodologyConfig"]>
          >)
        : null;
    },
    async reportForEpoch(gpuId, epoch) {
      return this.rows.some((r) => r.gpuId === gpuId && r.epoch === epoch);
    },
    async latestReport(gpuId) {
      const row = this.rows
        .filter((r) => r.gpuId === gpuId)
        .sort((a, b) => b.epoch - a.epoch)[0];
      return row ? { price: row.price, epoch: row.epoch, attestedAt: row.attestedAt } : null;
    },
    async recordReport(row) {
      if (this.rows.some((r) => r.gpuId === row.gpuId && r.epoch === row.epoch)) {
        return { inserted: false };
      }
      this.rows.push({ ...row });
      return { inserted: true };
    },
    async recordViolations(candidateId, _gpuId, _target, violations) {
      this.violations.push({ candidateId, violations: [...violations] });
      return { inserted: true };
    },
  };
}

function poller(store: AttestorStore, now: Date = NOW) {
  return new AttestorPoller({
    store,
    signer,
    domain: DOMAIN,
    config: CONFIG,
    epochLength: EPOCH_LENGTH,
    maxObservationAge: MAX_OBSERVATION_AGE,
    logger: silence(),
    now: () => now,
  });
}

function rowFor(store: { rows: ReportRow[] }, gpuId: string): ReportRow {
  const row = store.rows.filter((r) => r.gpuId === gpuId)[0];
  if (!row) throw new Error(`no report row for ${gpuId}`);
  return row;
}

describe("AttestorPoller", () => {
  it("attests the healthy candidate into the current epoch", async () => {
    const store = memoryStore([candidate()]);
    const result = await poller(store).tick();
    expect(result.attested).toBe(1);
    const row = rowFor(store, "H100_SXM_80GB");

    const nowSec = Math.floor(NOW.getTime() / 1000);
    const epoch = Math.floor(nowSec / EPOCH_LENGTH);
    expect(row.epoch).toBe(epoch);
    expect(row.validFrom).toBe(epoch * EPOCH_LENGTH);
    expect(row.validUntil).toBe((epoch + 1) * EPOCH_LENGTH);
    expect(row.price).toBe(25_000); // 2.50 × PRICE_SCALE
    expect(row.observedAt).toBe(Math.floor((NOW.getTime() - 10_000) / 1000));
    expect(row.calcHash).toBe(CALC_HASH);
    expect(row.version).toBe(1);
    expect(row.reportHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("signs with the attestor key over the configured domain", async () => {
    const store = memoryStore([candidate()]);
    await poller(store).tick();
    const row = rowFor(store, "H100_SXM_80GB");

    const signed: SignedReport = {
      report: buildReport({
        gpuId: "H100_SXM_80GB",
        price: 2.5,
        observedAtSec: row.observedAt,
        nowSec: Math.floor(NOW.getTime() / 1000),
        epochLength: EPOCH_LENGTH,
        maxObservationAge: MAX_OBSERVATION_AGE,
        calcHash: CALC_HASH as `0x${string}`,
      }),
      signature: row.signature as `0x${string}`,
    };
    // the persisted reportHash is the identity of the byte-identical updateData
    expect(row.reportHash).toBe(reportHash(signed));
    const bundle = reportTypedData(signed.report, DOMAIN);
    const ok = await verifyTypedData({
      domain: bundle.domain,
      types: bundle.types,
      primaryType: bundle.primaryType,
      message: bundle.message,
      signature: signed.signature,
      address: signer.address,
    });
    expect(ok).toBe(true);
  });

  it("is idempotent within an epoch: the next tick re-attests nothing", async () => {
    const store = memoryStore([candidate()]);
    const p = poller(store);
    expect((await p.tick()).attested).toBe(1);
    expect((await p.tick()).skipped).toBe(1);
    expect(store.rows).toHaveLength(1);
  });

  it("re-attests the same candidate into the next epoch within the observation floor", async () => {
    const store = memoryStore([candidate()]);
    await poller(store).tick();
    // 61s later: new epoch, observation 71s old — inside the 300s floor
    const next = new Date(NOW.getTime() + 61_000);
    const second = await poller(store, next).tick();
    expect(second.attested).toBe(1);
    expect(store.rows).toHaveLength(2);
    const epochs = store.rows.map((r) => r.epoch);
    expect(epochs[1]! - epochs[0]!).toBe(1);
    // the same observation is re-attested, not re-computed
    expect(store.rows[1]!.observedAt).toBe(store.rows[0]!.observedAt);
  });

  it("hard-stops when the observation is beyond the floor and records why", async () => {
    const stale = candidate({ computedAt: new Date(NOW.getTime() - (MAX_OBSERVATION_AGE + 1) * 1000) });
    const store = memoryStore([stale]);
    const result = await poller(store).tick();
    expect(result.attested).toBe(0);
    expect(store.rows).toHaveLength(0);
    expect(store.violations[0]?.violations.map((v) => v.code)).toContain(
      "observation_beyond_floor",
    );
  });

  it("refuses a candidate with no price (the one audit hard stop) and records it", async () => {
    const store = memoryStore([candidate({ price: null, confidenceLow: null, confidenceHigh: null })]);
    const result = await poller(store).tick();
    expect(result.attested).toBe(0);
    expect(store.rows).toHaveLength(0);
    expect(store.violations[0]?.violations.map((v) => v.code)).toContain("missing_price");
  });

  it("attests a flagged candidate anyway and rides the annotations on the report", async () => {
    const store = memoryStore([candidate({ status: "withheld" })]);
    const result = await poller(store).tick();
    expect(result.attested).toBe(1);
    expect(result.flagged).toBe(1);
    expect(store.violations[0]?.violations.map((v) => v.code)).toContain("not_publishable_status");
  });

  it("refuses to attest without the pinned methodology row (fail closed)", async () => {
    // the store returns null for the pinned version — the whole loop must
    // refuse before signing anything
    const breaking = memoryStore([candidate()]);
    breaking.methodologyConfig = async () => null;
    const result = await poller(breaking).tick();
    expect(result.attested).toBe(0);
    expect(breaking.rows).toHaveLength(0);
  });

  it("skips the whole cycle when source health is unavailable", async () => {
    const store = memoryStore([candidate()]);
    const p = new AttestorPoller({
      store,
      signer,
      domain: DOMAIN,
      config: CONFIG,
      epochLength: EPOCH_LENGTH,
      maxObservationAge: MAX_OBSERVATION_AGE,
      logger: silence(),
      fetchBreakers: async () => {
        throw new Error("oracle health unreachable");
      },
      now: () => NOW,
    });
    const result = await p.tick();
    expect(result.attested).toBe(0);
    expect(store.rows).toHaveLength(0);
  });

  it("survives a candidate crash and attests the others", async () => {
    const good = candidate({ id: "good", gpuId: "H200_141GB" });
    const bad = candidate({ id: "bad", gpuId: "BROKEN", calcHash: "not-hex" });
    const store = memoryStore([bad, good]);
    const result = await poller(store).tick();
    expect(result.attested).toBe(1);
    expect(store.rows.map((r) => r.gpuId)).toEqual(["H200_141GB"]);
  });

  it("does not overlap ticks (in-flight guard)", async () => {
    const store = memoryStore([candidate()]);
    const p = poller(store);
    const [a, b] = await Promise.all([p.tick(), p.tick()]);
    expect(a.attested + b.attested).toBe(1);
  });
});
