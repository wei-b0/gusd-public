import type { Db } from "@gusd/db";
import {
  getCandidateHistory,
  getLatestPublication,
  getMethodologyVersion,
  getPublication,
  recordPublication,
  recordPublishViolations,
} from "@gusd/db";
import type { MethodologyConfig } from "@gusd/pricing-engine";
import type { CandidateLike, PublishableIndexValue, PublishViolation } from "./types.js";

/**
 * Everything the poller needs from persistence, as an interface so the poll
 * loop is testable without a database. The candidate row type is the Drizzle
 * row minus fields the publisher never reads.
 */
export interface PublisherStore {
  /** Newest candidate per watched gpu (max computedAt). */
  latestCandidates(): Promise<CandidateLike[]>;
  /** The stored methodology config for an exact version — null when absent. */
  methodologyConfig(version: string): Promise<MethodologyConfig | null>;
  /** The last published value for this gpu on this target — null on a first publish. */
  latestPublication(
    gpuId: string,
    target: string,
  ): Promise<{ price: number; publishedAt: Date } | null>;
  alreadyPublished(candidateId: string, target: string): Promise<boolean>;
  recordPublication(
    value: PublishableIndexValue,
    txRef: string,
    target: string,
    publisherVersion: string,
    publishedAt: Date,
  ): Promise<{ inserted: boolean }>;
  recordViolations(
    candidateId: string,
    gpuId: string,
    target: string,
    violations: readonly PublishViolation[],
    publisherVersion: string,
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

export class DrizzlePublisherStore implements PublisherStore {
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

  async latestPublication(
    gpuId: string,
    target: string,
  ): Promise<{ price: number; publishedAt: Date } | null> {
    const row = await getLatestPublication(this.db, gpuId, target);
    return row ? { price: row.price, publishedAt: row.publishedAt } : null;
  }

  async alreadyPublished(candidateId: string, target: string): Promise<boolean> {
    return (await getPublication(this.db, candidateId, target)) !== null;
  }

  async recordPublication(
    value: PublishableIndexValue,
    txRef: string,
    target: string,
    publisherVersion: string,
    publishedAt: Date,
  ): Promise<{ inserted: boolean }> {
    return recordPublication(this.db, {
      candidateId: value.candidateId,
      gpuId: value.gpuId,
      panelId: value.panelId,
      price: value.price,
      confidenceLow: value.confidenceLow,
      confidenceHigh: value.confidenceHigh,
      status: value.status,
      publisherVersion,
      target,
      txRef,
      publishedAt,
    });
  }

  async recordViolations(
    candidateId: string,
    gpuId: string,
    target: string,
    violations: readonly PublishViolation[],
    publisherVersion: string,
    recordedAt: Date,
  ): Promise<{ inserted: boolean }> {
    return recordPublishViolations(this.db, {
      candidateId,
      gpuId,
      target,
      violations,
      publisherVersion,
      recordedAt,
    });
  }
}
