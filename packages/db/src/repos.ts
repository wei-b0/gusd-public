import { and, desc, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import type {
  FailureKind,
  PricingTier,
  ProviderPriceResult,
  RunStatus,
  SourceType,
  UnmappedRecord,
  WalletKind,
} from "@gusd/types";
import { obsFingerprint, rawObservations } from "./schema/observations.js";
import type { ProviderSeed } from "./schema/providers.js";
import { providers } from "./schema/providers.js";
export type { ProviderSeed } from "./schema/providers.js";
import { collectionRuns, sourceFailures } from "./schema/collections.js";
import { fxRates, watchdogComparisons, watchdogFeeds } from "./schema/aux.js";
import {
  indexCandidates,
  methodologyVersions,
  providerPrices,
  publishViolations,
  publishedIndexValues,
} from "./schema/pricing.js";
import { normalizedObservations, unmappedLabels } from "./schema/observations.js";
import { userWallets } from "./schema/identity.js";
import type { Executor } from "./client.js";

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * Idempotent seed from the static registry. The registry is the source of
 * truth for role/cadence: an operator who needs to exclude a provider edits
 * the registry (a reviewed change), not the live table.
 */
export async function seedProviders(ex: Executor, seeds: readonly ProviderSeed[]): Promise<void> {
  for (const seed of seeds) {
    await ex
      .insert(providers)
      .values({
        slug: seed.slug,
        name: seed.name,
        sourceType: seed.sourceType,
        role: seed.role,
        cadenceTier: seed.cadenceTier,
        homepageUrl: seed.homepageUrl ?? null,
        config: seed.config ?? {},
      })
      .onConflictDoUpdate({
        target: providers.slug,
        set: {
          name: seed.name,
          sourceType: seed.sourceType,
          role: seed.role,
          cadenceTier: seed.cadenceTier,
          homepageUrl: seed.homepageUrl ?? null,
          config: seed.config ?? {},
          updatedAt: new Date(),
        },
      });
  }
}

export async function listProviders(ex: Executor) {
  return ex.select().from(providers).orderBy(providers.slug);
}

export async function getProviderBySlug(ex: Executor, slug: string) {
  const rows = await ex.select().from(providers).where(eq(providers.slug, slug)).limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Methodology versions
// ---------------------------------------------------------------------------

export interface MethodologyVersionInput {
  version: string;
  config: Record<string, unknown>;
  configHash: string;
  changelog?: string;
}

/**
 * Insert-once per version. A version that already exists is a no-op; a new
 * version supersedes the currently open one — the partial unique index allows
 * at most one open row, so a new methodology can only land by closing its
 * predecessor. Bootstrap is single-caller (oracle startup, test setup); two
 * concurrent bootstraps would close each other's rows and fail loudly at
 * first computation rather than corrupt anything (append-only rows).
 */
export async function ensureMethodologyVersion(
  ex: Executor,
  input: MethodologyVersionInput,
): Promise<void> {
  await ex.transaction(async (tx) => {
    const existing = await tx
      .select({ id: methodologyVersions.id })
      .from(methodologyVersions)
      .where(eq(methodologyVersions.version, input.version))
      .limit(1);
    if (existing.length > 0) return;
    await tx
      .update(methodologyVersions)
      .set({ effectiveTo: new Date() })
      .where(isNull(methodologyVersions.effectiveTo));
    await tx
      .insert(methodologyVersions)
      .values({
        version: input.version,
        config: input.config,
        configHash: input.configHash,
        changelog: input.changelog ?? null,
        effectiveFrom: new Date(),
      })
      .onConflictDoNothing({ target: methodologyVersions.version });
  });
}

export async function getCurrentMethodology(ex: Executor) {
  const rows = await ex
    .select()
    .from(methodologyVersions)
    .where(isNull(methodologyVersions.effectiveTo))
    .orderBy(desc(methodologyVersions.effectiveFrom))
    .limit(1);
  return rows[0] ?? null;
}

/** The stored config for one exact methodology version — the publisher's
 *  threshold source (it must not trust the candidate's own receipt). */
export async function getMethodologyVersion(ex: Executor, version: string) {
  const rows = await ex
    .select()
    .from(methodologyVersions)
    .where(eq(methodologyVersions.version, version))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Collection runs + failures
// ---------------------------------------------------------------------------

export interface CollectionRunInput {
  providerId: string;
  collectorId: string;
  trigger: "scheduled" | "manual" | "replay";
  attempt: number;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  status: RunStatus;
  rawCount: number;
  normalizedCount: number;
  unmappedCount: number;
  failureKind?: FailureKind | null;
  errorMessage?: string | null;
}

export async function insertCollectionRun(ex: Executor, run: CollectionRunInput) {
  const rows = await ex
    .insert(collectionRuns)
    .values({
      providerId: run.providerId,
      collectorId: run.collectorId,
      trigger: run.trigger,
      attempt: run.attempt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      status: run.status,
      rawCount: run.rawCount,
      normalizedCount: run.normalizedCount,
      unmappedCount: run.unmappedCount,
      failureKind: run.failureKind ?? null,
      errorMessage: run.errorMessage ?? null,
    })
    .returning({ id: collectionRuns.id });
  const row = rows[0];
  if (!row) throw new Error("insertCollectionRun: no id returned");
  return row.id;
}

export interface SourceFailureInput {
  providerId: string;
  collectorId: string;
  collectionRunId?: string | null;
  failureKind: FailureKind;
  detail?: string | null;
  retryAfterSeconds?: number | null;
  circuitOpened?: boolean;
  occurredAt: Date;
}

export async function insertSourceFailures(
  ex: Executor,
  failures: readonly SourceFailureInput[],
): Promise<void> {
  if (failures.length === 0) return;
  await ex.insert(sourceFailures).values(
    failures.map((f) => ({
      providerId: f.providerId,
      collectorId: f.collectorId,
      collectionRunId: f.collectionRunId ?? null,
      failureKind: f.failureKind,
      detail: f.detail ?? null,
      retryAfterSeconds: f.retryAfterSeconds ?? null,
      circuitOpened: f.circuitOpened ?? false,
      occurredAt: f.occurredAt,
    })),
  );
}

/** Recent run outcomes, newest first — the breaker rehydrates from this. */
export async function getRecentRuns(ex: Executor, providerId: string, limit = 10) {
  return ex
    .select({ status: collectionRuns.status, startedAt: collectionRuns.startedAt })
    .from(collectionRuns)
    .where(eq(collectionRuns.providerId, providerId))
    .orderBy(desc(collectionRuns.startedAt))
    .limit(limit);
}

/**
 * The run row is written first (raw rows reference it), so its outcome
 * counts are filled in at the end of the same transaction.
 */
export async function updateCollectionRunCounts(
  ex: Executor,
  runId: string,
  counts: { rawCount: number; normalizedCount: number; unmappedCount: number },
): Promise<void> {
  await ex
    .update(collectionRuns)
    .set({
      rawCount: counts.rawCount,
      normalizedCount: counts.normalizedCount,
      unmappedCount: counts.unmappedCount,
    })
    .where(eq(collectionRuns.id, runId));
}

/** Last finished run per collector — the scheduler resumes cadence from this. */
export async function getLastRunPerCollector(ex: Executor) {
  return ex
    .select({
      collectorId: collectionRuns.collectorId,
      lastFinishedAt: sql<string>`max(${collectionRuns.finishedAt})`,
    })
    .from(collectionRuns)
    .groupBy(collectionRuns.collectorId);
}

// ---------------------------------------------------------------------------
// Raw + normalized observations
// ---------------------------------------------------------------------------

export interface RawRowInput {
  observation: {
    providerSlug: string;
    sourceType: SourceType;
    rawGpuLabel: string;
    rawPrice: number | null;
    rawCurrency: string;
    rawUnit: string;
    gpuCount: number | null;
    region: string | null;
    pricingTier: PricingTier | null;
    observedAt: Date;
    sourceUrl: string | null;
    sourceId: string | null;
    rawPayload: unknown;
  };
  providerId: string;
  collectionRunId: string | null;
}

/**
 * Insert raw observations, deduping on obsFingerprint. Returns ONLY the rows
 * that were actually inserted — callers normalize/insert downstream rows for
 * exactly these, which is what makes re-runs and retries idempotent. The
 * fingerprint is returned with each id so callers can map an inserted row
 * back to the raw input that produced it.
 */
export async function insertRawObservations(
  ex: Executor,
  rows: readonly RawRowInput[],
): Promise<{ id: string; rawGpuLabel: string; obsFingerprint: string }[]> {
  if (rows.length === 0) return [];
  const values = await Promise.all(
    rows.map(async (r) => ({
      collectionRunId: r.collectionRunId,
      providerId: r.providerId,
      sourceType: r.observation.sourceType,
      rawGpuLabel: r.observation.rawGpuLabel,
      rawPrice: r.observation.rawPrice,
      rawCurrency: r.observation.rawCurrency,
      rawUnit: r.observation.rawUnit,
      gpuCount: r.observation.gpuCount,
      region: r.observation.region,
      pricingTier: r.observation.pricingTier,
      observedAt: r.observation.observedAt,
      sourceUrl: r.observation.sourceUrl,
      sourceId: r.observation.sourceId,
      rawPayload: r.observation.rawPayload,
      obsFingerprint: await obsFingerprint({
        providerSlug: r.observation.providerSlug,
        sourceId: r.observation.sourceId,
        observedAt: r.observation.observedAt,
        rawGpuLabel: r.observation.rawGpuLabel,
        rawUnit: r.observation.rawUnit,
        region: r.observation.region,
        gpuCount: r.observation.gpuCount,
      }),
    })),
  );
  return ex
    .insert(rawObservations)
    .values(values)
    .onConflictDoNothing({ target: rawObservations.obsFingerprint })
    .returning({
      id: rawObservations.id,
      rawGpuLabel: rawObservations.rawGpuLabel,
      obsFingerprint: rawObservations.obsFingerprint,
    });
}

export interface NormalizedRowInput {
  rawObservationId: string;
  providerId: string;
  sourceType: SourceType;
  gpuId: string;
  usdPerGpuHour: number;
  pricingTier: PricingTier;
  gpuCount: number | null;
  region: string | null;
  available: boolean | null;
  offerId: string | null;
  machineId: string | null;
  hostId: string | null;
  rawTotalUsdPerHour: number | null;
  isBid: boolean;
  fxRateUsed: number | null;
  fxRateDate: string | null;
  normalizationVersion: string;
  observedAt: Date;
}

export async function insertNormalizedObservations(
  ex: Executor,
  rows: readonly NormalizedRowInput[],
): Promise<void> {
  if (rows.length === 0) return;
  await ex
    .insert(normalizedObservations)
    .values(rows.map((r) => ({ ...r })))
    .onConflictDoNothing({ target: normalizedObservations.rawObservationId });
}

export interface UnmappedRowInput {
  providerId: string;
  rawGpuLabel: string;
  sampleRawObservationId: string | null;
  lastSeenAt: Date;
}

/**
 * Occurrence-counting upsert. The worklist is how unknown labels get seen.
 * A batch may carry the same unknown label many times (a provider returning
 * dozens of offers of one SKU we don't know); Postgres refuses an
 * ON CONFLICT DO UPDATE that would touch the same row twice in one
 * statement, so the batch collapses to one row per (provider, label).
 * `occurrences` therefore counts ingestion batches, not raw rows — one label
 * seen ten times in a single collection advances it by one, keeping the
 * worklist flood-invariant.
 */
export async function upsertUnmappedLabels(
  ex: Executor,
  entries: readonly UnmappedRowInput[],
): Promise<void> {
  if (entries.length === 0) return;
  const merged = new Map<string, { entry: UnmappedRowInput; firstSeenAt: Date }>();
  for (const e of entries) {
    const key = JSON.stringify([e.providerId, e.rawGpuLabel]);
    const prev = merged.get(key);
    if (prev === undefined) {
      merged.set(key, { entry: e, firstSeenAt: e.lastSeenAt });
      continue;
    }
    if (prev.entry.sampleRawObservationId === null && e.sampleRawObservationId !== null) {
      prev.entry = { ...prev.entry, sampleRawObservationId: e.sampleRawObservationId };
    }
    if (e.lastSeenAt > prev.entry.lastSeenAt) {
      prev.entry = { ...prev.entry, lastSeenAt: e.lastSeenAt };
    }
    if (e.lastSeenAt < prev.firstSeenAt) {
      prev.firstSeenAt = e.lastSeenAt;
    }
  }
  await ex
    .insert(unmappedLabels)
    .values(
      [...merged.values()].map((m) => ({
        providerId: m.entry.providerId,
        rawGpuLabel: m.entry.rawGpuLabel,
        sampleRawObservationId: m.entry.sampleRawObservationId,
        firstSeenAt: m.firstSeenAt,
        lastSeenAt: m.entry.lastSeenAt,
      })),
    )
    .onConflictDoUpdate({
      target: [unmappedLabels.providerId, unmappedLabels.rawGpuLabel],
      set: {
        occurrences: sql`${unmappedLabels.occurrences} + 1`,
        lastSeenAt: sql`excluded.last_seen_at`,
      },
    });
}

/** Window query for the engine runner: observations joined to provider truth. */
export async function getObservationsInWindow(
  ex: Executor,
  params: { gpuId: string; windowStart: Date; windowEnd: Date },
) {
  return ex
    .select({
      id: normalizedObservations.id,
      providerSlug: providers.slug,
      providerRole: providers.role,
      providerConfig: providers.config,
      usdPerGpuHour: normalizedObservations.usdPerGpuHour,
      pricingTier: normalizedObservations.pricingTier,
      gpuCount: normalizedObservations.gpuCount,
      region: normalizedObservations.region,
      available: normalizedObservations.available,
      offerId: normalizedObservations.offerId,
      machineId: normalizedObservations.machineId,
      hostId: normalizedObservations.hostId,
      rawTotalUsdPerHour: normalizedObservations.rawTotalUsdPerHour,
      isBid: normalizedObservations.isBid,
      observedAt: normalizedObservations.observedAt,
    })
    .from(normalizedObservations)
    .innerJoin(providers, eq(providers.id, normalizedObservations.providerId))
    .where(
      and(
        eq(normalizedObservations.gpuId, params.gpuId),
        gte(normalizedObservations.observedAt, params.windowStart),
        // Half-open [windowStart, windowEnd): an observation stamped exactly
        // at windowEnd belongs to the next window, not to two at once. The
        // /candles bucketing uses the same half-open convention.
        lt(normalizedObservations.observedAt, params.windowEnd),
      ),
    )
    .orderBy(normalizedObservations.observedAt);
}

// ---------------------------------------------------------------------------
// Provider prices + index candidates + publications
// ---------------------------------------------------------------------------

export interface ProviderPriceRowInput {
  providerId: string;
  gpuId: string;
  panelId: string | null;
  price: number | null;
  method: "median" | "volume_weighted_median" | "thin_book_holdout";
  executable: boolean;
  sampleSize: number;
  windowStart: Date;
  windowEnd: Date;
  computedAt: Date;
  methodologyVersion: string;
  params: Record<string, unknown>;
  receipts: ProviderPriceResult["receipts"];
}

export async function insertProviderPrices(
  ex: Executor,
  rows: readonly ProviderPriceRowInput[],
): Promise<void> {
  if (rows.length === 0) return;
  await ex.insert(providerPrices).values(rows.map((r) => ({ ...r })));
}

/** Per-provider price history for trailing stats (jump screen, sigma). */
export async function getProviderPriceHistory(
  ex: Executor,
  params: { gpuId: string; since: Date },
) {
  return ex
    .select({
      providerId: providerPrices.providerId,
      price: providerPrices.price,
      executable: providerPrices.executable,
      method: providerPrices.method,
      computedAt: providerPrices.computedAt,
    })
    .from(providerPrices)
    .where(
      and(
        eq(providerPrices.gpuId, params.gpuId),
        gte(providerPrices.computedAt, params.since),
      ),
    )
    .orderBy(providerPrices.computedAt);
}

export interface IndexCandidateRowInput {
  gpuId: string;
  panelId: string;
  price: number | null;
  confidenceLow: number | null;
  confidenceHigh: number | null;
  dispersion: number;
  status: "healthy" | "degraded" | "stale" | "withheld" | "frozen";
  providersObserved: number;
  providersContributing: number;
  methodologyVersion: string;
  gates: unknown[];
  contributors: unknown[];
  exclusions: unknown[];
  calcParams: Record<string, unknown>;
  calcHash: string;
  windowStart: Date;
  windowEnd: Date;
  computedAt: Date;
  priorCandidateId?: string | null;
}

/**
 * Insert a candidate. A byte-identical recomputation (same gpu + calcHash,
 * non-stale) is the same fact and dedups to nothing; the return value says
 * whether this call created the row.
 */
export async function insertIndexCandidate(
  ex: Executor,
  row: IndexCandidateRowInput,
): Promise<{ id: string; inserted: boolean }> {
  const rows = await ex
    .insert(indexCandidates)
    .values({
      gpuId: row.gpuId,
      panelId: row.panelId,
      price: row.price,
      confidenceLow: row.confidenceLow,
      confidenceHigh: row.confidenceHigh,
      dispersion: row.dispersion,
      status: row.status,
      providersObserved: row.providersObserved,
      providersContributing: row.providersContributing,
      methodologyVersion: row.methodologyVersion,
      gates: row.gates,
      contributors: row.contributors,
      exclusions: row.exclusions,
      calcParams: row.calcParams,
      calcHash: row.calcHash,
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
      computedAt: row.computedAt,
      priorCandidateId: row.priorCandidateId ?? null,
    })
    .onConflictDoNothing({
      target: [indexCandidates.gpuId, indexCandidates.calcHash],
      where: sql`status <> 'stale'`,
    })
    .returning({ id: indexCandidates.id });
  const first = rows[0];
  if (first) return { id: first.id, inserted: true };
  const existing = await ex
    .select({ id: indexCandidates.id })
    .from(indexCandidates)
    .where(
      and(eq(indexCandidates.gpuId, row.gpuId), eq(indexCandidates.calcHash, row.calcHash)),
    )
    .limit(1);
  const found = existing[0];
  if (!found) throw new Error("insertIndexCandidate: conflict but no existing row found");
  return { id: found.id, inserted: false };
}

/** Latest candidate per gpu (supersession is derived: max computedAt wins). */
export async function getLatestCandidatesByGpu(ex: Executor, gpuIds?: readonly string[]) {
  const query = ex
    .selectDistinctOn([indexCandidates.gpuId])
    .from(indexCandidates)
    .orderBy(indexCandidates.gpuId, desc(indexCandidates.computedAt));
  if (gpuIds && gpuIds.length > 0) {
    return query.where(inArray(indexCandidates.gpuId, [...gpuIds]));
  }
  return query;
}

export async function getLatestCandidate(ex: Executor, gpuId: string) {
  const rows = await ex
    .select()
    .from(indexCandidates)
    .where(eq(indexCandidates.gpuId, gpuId))
    .orderBy(desc(indexCandidates.computedAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Latest publishable candidate (healthy or degraded) for a gpu. */
export async function getLatestHealthyCandidate(ex: Executor, gpuId: string) {
  const rows = await ex
    .select()
    .from(indexCandidates)
    .where(
      and(
        eq(indexCandidates.gpuId, gpuId),
        inArray(indexCandidates.status, ["healthy", "degraded"]),
      ),
    )
    .orderBy(desc(indexCandidates.computedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getCandidateById(ex: Executor, id: string) {
  const rows = await ex.select().from(indexCandidates).where(eq(indexCandidates.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getCandidatesSince(ex: Executor, since: Date) {
  return ex
    .select()
    .from(indexCandidates)
    .where(gte(indexCandidates.computedAt, since))
    .orderBy(desc(indexCandidates.computedAt));
}

/** Candidate history for one gpu, newest first (API /history endpoint). */
export async function getCandidateHistory(ex: Executor, gpuId: string, limit: number) {
  return ex
    .select()
    .from(indexCandidates)
    .where(eq(indexCandidates.gpuId, gpuId))
    .orderBy(desc(indexCandidates.computedAt))
    .limit(limit);
}

export interface CandidateCandleRow {
  bucketStart: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  samples: number;
}

/**
 * OHLC over the canonical benchmark series (`index_candidates`) bucketed to
 * `intervalSec`. Every computed benchmark whose price is non-null enters its
 * interval: open/close are the first/last computation in the bucket (row id
 * breaks computed_at ties — earliest id wins open, latest id wins close, so
 * both ends resolve to the same row only when every print in the bucket ties),
 * high/low the extremes, samples the row count.
 * Publication gating (withheld/frozen) applies to the chain, not to this
 * stored series — the row's price is still the engine's benchmark estimate
 * for its window, which is exactly what a series view of the database shows.
 * Buckets with no computations do not exist; the series never interpolates
 * across a gap. Served by GET /v1/prices/:gpu/candles.
 */
export async function getCandidateCandles(
  ex: Executor,
  gpuId: string,
  intervalSec: number,
  from: Date,
  to: Date,
): Promise<CandidateCandleRow[]> {
  const result = await ex.execute<{ bucketStart: Date; open: number; high: number; low: number; close: number; samples: number }>(sql`
    with windowed as (
      select
        price,
        computed_at,
        id,
        to_timestamp(floor(extract(epoch from computed_at) / ${intervalSec}) * ${intervalSec}) as bucket
      from index_candidates
      where gpu_id = ${gpuId}
        and price is not null
        and computed_at >= ${from}
        and computed_at < ${to}
    )
    select
      bucket as "bucketStart",
      (array_agg(price order by computed_at asc, id asc))[1]::float8 as open,
      max(price)::float8 as high,
      min(price)::float8 as low,
      (array_agg(price order by computed_at desc, id desc))[1]::float8 as close,
      count(*)::int as samples
    from windowed
    group by bucket
    order by bucket asc
  `);
  return result.rows.map((r) => ({
    bucketStart: new Date(r.bucketStart),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    samples: r.samples,
  }));
}

export interface PublicationRowInput {
  candidateId: string;
  gpuId: string;
  panelId: string;
  price: number;
  confidenceLow: number | null;
  confidenceHigh: number | null;
  status: "healthy" | "degraded";
  publisherVersion: string;
  target: string;
  txRef: string;
  publishedAt: Date;
}

/** Idempotent by (candidateId, target): returns whether this call inserted. */
export async function recordPublication(
  ex: Executor,
  row: PublicationRowInput,
): Promise<{ inserted: boolean }> {
  const rows = await ex
    .insert(publishedIndexValues)
    .values({ ...row })
    .onConflictDoNothing({
      target: [publishedIndexValues.candidateId, publishedIndexValues.target],
    })
    .returning({ id: publishedIndexValues.id });
  return { inserted: rows.length > 0 };
}

export async function getPublication(ex: Executor, candidateId: string, target: string) {
  const rows = await ex
    .select()
    .from(publishedIndexValues)
    .where(
      and(
        eq(publishedIndexValues.candidateId, candidateId),
        eq(publishedIndexValues.target, target),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Most recent publication of a gpu on a target — the publisher's jump baseline. */
export async function getLatestPublication(ex: Executor, gpuId: string, target: string) {
  const rows = await ex
    .select({
      candidateId: publishedIndexValues.candidateId,
      price: publishedIndexValues.price,
      publishedAt: publishedIndexValues.publishedAt,
    })
    .from(publishedIndexValues)
    .where(
      and(eq(publishedIndexValues.gpuId, gpuId), eq(publishedIndexValues.target, target)),
    )
    .orderBy(desc(publishedIndexValues.publishedAt))
    .limit(1);
  return rows[0] ?? null;
}

export interface PublishViolationRowInput {
  candidateId: string;
  gpuId: string;
  target: string;
  violations: readonly { code: string; detail: string }[];
  publisherVersion: string;
  recordedAt: Date;
}

/** Idempotent by (candidateId, target): a rejected candidate stays rejected. */
export async function recordPublishViolations(
  ex: Executor,
  row: PublishViolationRowInput,
): Promise<{ inserted: boolean }> {
  const rows = await ex
    .insert(publishViolations)
    .values({
      candidateId: row.candidateId,
      gpuId: row.gpuId,
      target: row.target,
      violations: [...row.violations],
      publisherVersion: row.publisherVersion,
      createdAt: row.recordedAt,
    })
    .onConflictDoNothing({
      target: [publishViolations.candidateId, publishViolations.target],
    })
    .returning({ id: publishViolations.id });
  return { inserted: rows.length > 0 };
}

// ---------------------------------------------------------------------------
// FX + watchdogs
// ---------------------------------------------------------------------------

export interface FxRateInput {
  currency: string;
  rateDate: string;
  usdPerUnit: number;
  fetchedAt: Date;
  source?: string;
}

/** First-write-wins: conflicts are the same fact, never corrected in place. */
export async function insertFxRates(ex: Executor, rows: readonly FxRateInput[]): Promise<void> {
  if (rows.length === 0) return;
  await ex
    .insert(fxRates)
    .values(
      rows.map((r) => ({
        currency: r.currency,
        rateDate: r.rateDate,
        usdPerUnit: r.usdPerUnit,
        fetchedAt: r.fetchedAt,
        source: r.source ?? "ecb",
      })),
    )
    .onConflictDoNothing({ target: [fxRates.currency, fxRates.rateDate] });
}

/** All stored rates — the oracle's FX cache is rebuilt from this. */
export async function listFxRates(ex: Executor) {
  return ex.select().from(fxRates).orderBy(fxRates.currency, desc(fxRates.rateDate));
}

/** Latest rate at or before asOfDate ('YYYY-MM-DD'). Null = hold out, never guess. */
export async function getFxRate(ex: Executor, currency: string, asOfDate: string) {
  const rows = await ex
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.currency, currency), lte(fxRates.rateDate, asOfDate)))
    .orderBy(desc(fxRates.rateDate))
    .limit(1);
  return rows[0] ?? null;
}

export interface WatchdogFeedInput {
  feed: string;
  payload: unknown;
  licenseNote: string;
  fetchedAt: Date;
}

export async function insertWatchdogFeed(ex: Executor, row: WatchdogFeedInput): Promise<void> {
  await ex.insert(watchdogFeeds).values({ ...row });
}

export interface WatchdogComparisonInput {
  feed: string;
  gpuId: string;
  theirPrice: number;
  ourPrice: number | null;
  deviationAbs: number;
  deviationPct: number | null;
  comparedAt: Date;
}

export async function insertWatchdogComparisons(
  ex: Executor,
  rows: readonly WatchdogComparisonInput[],
): Promise<void> {
  if (rows.length === 0) return;
  await ex.insert(watchdogComparisons).values(rows.map((r) => ({ ...r })));
}

/** Convenience re-export so callers can build UnmappedRecord-driven upserts. */
export type { UnmappedRecord };

// ---------------------------------------------------------------------------
// User wallets (identity boundary)
// ---------------------------------------------------------------------------

export interface UserWalletUpsert {
  /** Auth-provider user DID (did:privy:…). */
  privyUserId: string;
  /** Hex address; normalized to lowercase here so the check constraint and
   *  the unique index see one canonical case for every wallet. */
  address: string;
  walletKind: WalletKind;
  /** Address-derived display label; never personal data. */
  label?: string | null;
}

export type UserWalletRow = typeof userWallets.$inferSelect;

/**
 * The single statement that makes 1 user = 1 wallet true at rest: a wallet
 * authenticating again (fresh session, new provider identity, another day)
 * maps back to its existing row — one row per address, ever. A different
 * wallet is a different row and therefore a different gUSD account.
 */
export async function upsertUserWallet(
  ex: Executor,
  input: UserWalletUpsert,
): Promise<UserWalletRow> {
  const address = input.address.toLowerCase();
  const rows = await ex
    .insert(userWallets)
    .values({
      privyUserId: input.privyUserId,
      address,
      walletKind: input.walletKind,
      label: input.label ?? null,
    })
    .onConflictDoUpdate({
      target: userWallets.address,
      set: {
        privyUserId: input.privyUserId,
        walletKind: input.walletKind,
        label: input.label ?? null,
        lastSeenAt: new Date(),
      },
    })
    .returning();
  return rows[0]!;
}

export async function findUserWalletByAddress(
  ex: Executor,
  address: string,
): Promise<UserWalletRow | null> {
  const rows = await ex
    .select()
    .from(userWallets)
    .where(eq(userWallets.address, address.toLowerCase()))
    .limit(1);
  return rows[0] ?? null;
}

export async function findUserWalletByPrivyUserId(
  ex: Executor,
  privyUserId: string,
): Promise<UserWalletRow | null> {
  const rows = await ex
    .select()
    .from(userWallets)
    .where(eq(userWallets.privyUserId, privyUserId))
    .limit(1);
  return rows[0] ?? null;
}
