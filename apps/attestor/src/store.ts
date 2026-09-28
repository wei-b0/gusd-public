import type { Db } from "@gusd/db";
import {
  getCandidateHistory,
  getLatestOracleReport,
  getMethodologyVersion,
  getOracleReport,
  insertOracleReport,
  recordPublishViolations,
} from "@gusd/db";
import type { MethodologyConfig } from "@gusd/pricing-engine";
import type { CandidateLike, PublishViolation } from "./types.js";

/**
 * Everything the poller needs from persistence, as an interface so the attest
 * loop is testable without a database. The candidate row type is the Drizzle
 * row minus fields the attestor never reads.
 */
export interface AttestorStore {
  /** Newest candidate per watched gpu (max computedAt). */
  latestCandidates(): Promise<CandidateLike[]>;
  /** The stored methodology config for an exact version — null when absent. */
  methodologyConfig(version: string): Promise<MethodologyConfig | null>;
  /** Whether a report is already attested into this (gpu, epoch). */
  reportForEpoch(gpuId: string, epoch: number): Promise<boolean>;
  /** The newest report for this gpu — the jump annotation's baseline. */
  latestReport(gpuId: string): Promise<{ price: number; epoch: number; attestedAt: Date } | null>;
  /** Persist a signed report — idempotent by (gpu_id, epoch). */
  recordReport(row: {
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
  }): Promise<{ inserted: boolean }>;
  recordViolations(
    candidateId: string,
    gpuId: string,
    target: string,
    violations: readonly PublishViolation[],
    attestorVersion: string,
    recordedAt: Date,
  ): Promise<{ inserted: boolean }>;
}

type CandidateRow = Awaited<ReturnType<typeof getCandidateHistory>>[number];

function candidateFromRow(row: CandidateRow): CandidateLike {
  return {
    id: row.id,
    gpuId: row.gpuId,
    panelId: row.panelId,
    price: row.price,
    confidenceLow: row.confidenceLow,
    confidenceHigh: row.confidenceHigh,
    status: row.status,
    providersContributing: row.providersContributing,
    dispersion: row.dispersion,
    methodologyVersion: row.methodologyVersion,
    calcHash: row.calcHash,
    computedAt: row.computedAt,
    contributors: (row.contributors ?? []) as { providerId: string }[],
  };
}

export class DrizzleAttestorStore implements AttestorStore {
  constructor(
    private readonly db: Db,
    /** The gpu ids to poll — the settlement panels' gpu ids. */
    private readonly gpuIds: readonly string[],
  ) {}

  async latestCandidates(): Promise<CandidateLike[]> {
    // Newest candidate per watched gpu (append-only table: supersession is
    // derived at read time, never written back).
    const out: CandidateLike[] = [];
    for (const gpuId of this.gpuIds) {
      const rows = await getCandidateHistory(this.db, gpuId, 1);
      if (rows[0] !== undefined) out.push(candidateFromRow(rows[0]));
    }
    return out;
  }

  async methodologyConfig(version: string): Promise<MethodologyConfig | null> {
    const row = await getMethodologyVersion(this.db, version);
    return (row?.config as MethodologyConfig | undefined) ?? null;
  }

  async reportForEpoch(gpuId: string, epoch: number): Promise<boolean> {
    return (await getOracleReport(this.db, gpuId, epoch)) !== null;
  }

  async latestReport(gpuId: string) {
    const row = await getLatestOracleReport(this.db, gpuId);
    if (!row) return null;
    return { price: row.price, epoch: row.epoch, attestedAt: row.attestedAt };
  }

  async recordReport(row: Parameters<AttestorStore["recordReport"]>[0]) {
    return insertOracleReport(this.db, row);
  }

  async recordViolations(
    candidateId: string,
    gpuId: string,
    target: string,
    violations: readonly PublishViolation[],
    attestorVersion: string,
    recordedAt: Date,
  ): Promise<{ inserted: boolean }> {
    return recordPublishViolations(this.db, {
      candidateId,
      gpuId,
      target,
      violations: [...violations],
      publisherVersion: attestorVersion,
      recordedAt,
    });
  }
}
