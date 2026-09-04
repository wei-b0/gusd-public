import { sha256Hex } from "@gusd/types";
import {
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { PricingTier, SourceType, UnmappedRecord } from "@gusd/types";
import { createdAt, uuidPk } from "./common.js";
import { pricingTierEnum, sourceTypeEnum, unmappedStatusEnum } from "./enums.js";
import { collectionRuns } from "./collections.js";
import { providers } from "./providers.js";

/**
 * Stage 1 storage: exactly what the provider published. Append-only (enforced
 * again by DB trigger) and dedup-keyed by obsFingerprint so a retried batch,
 * a replay, or a restart mid-ingest can never double-insert a row.
 */
export const rawObservations = pgTable(
  "raw_observations",
  {
    id: uuidPk(),
    collectionRunId: uuid("collection_run_id").references(() => collectionRuns.id),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id),
    sourceType: sourceTypeEnum("source_type").notNull(),
    rawGpuLabel: text("raw_gpu_label").notNull(),
    rawPrice: numeric("raw_price", { precision: 20, scale: 8, mode: "number" }),
    rawCurrency: char("raw_currency", { length: 3 }).notNull(),
    rawUnit: text("raw_unit").notNull(),
    gpuCount: integer("gpu_count"),
    region: text("region"),
    pricingTier: pricingTierEnum("pricing_tier"),
    observedAt: timestamp("observed_at", { withTimezone: true, mode: "date" }).notNull(),
    sourceUrl: text("source_url"),
    /** The provider's own row identifier (offer id, instance type, SKU code). */
    sourceId: text("source_id"),
    rawPayload: jsonb("raw_payload").$type<unknown>().notNull(),
    /** sha256 over (providerSlug, sourceId, observedAt, label, unit, region, gpuCount). */
    obsFingerprint: text("obs_fingerprint").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("raw_observations_fingerprint_unique").on(t.obsFingerprint),
    index("raw_observations_provider_observed_idx").on(t.providerId, t.observedAt.desc()),
  ],
);

/**
 * Stage 2 storage: the normalized, comparable form. One row max per raw
 * observation (unique rawObservationId); unmapped labels get NO row here.
 */
export const normalizedObservations = pgTable(
  "normalized_observations",
  {
    id: uuidPk(),
    rawObservationId: uuid("raw_observation_id")
      .notNull()
      .references(() => rawObservations.id),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id),
    sourceType: sourceTypeEnum("source_type").notNull(),
    /** Canonical catalog id from @gusd/gpu-catalog (e.g. "H100_SXM_80GB"). */
    gpuId: text("gpu_id").notNull(),
    usdPerGpuHour: numeric("usd_per_gpu_hour", { precision: 12, scale: 4, mode: "number" }).notNull(),
    pricingTier: pricingTierEnum("pricing_tier").notNull(),
    gpuCount: integer("gpu_count"),
    region: text("region"),
    available: boolean("available"),
    offerId: text("offer_id"),
    machineId: text("machine_id"),
    hostId: text("host_id"),
    /** Instance-level total USD/hour as published (drives the arithmetic tripwire). */
    rawTotalUsdPerHour: numeric("raw_total_usd_per_hour", {
      precision: 20,
      scale: 8,
      mode: "number",
    }),
    isBid: boolean("is_bid").notNull().default(false),
    fxRateUsed: numeric("fx_rate_used", { precision: 20, scale: 10, mode: "number" }),
    fxRateDate: date("fx_rate_date"),
    normalizationVersion: text("normalization_version").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("normalized_observations_raw_unique").on(t.rawObservationId),
    index("normalized_observations_gpu_observed_idx").on(t.gpuId, t.observedAt.desc()),
    index("normalized_observations_provider_gpu_idx").on(
      t.providerId,
      t.gpuId,
      t.observedAt.desc(),
    ),
    index("normalized_observations_machine_idx").on(t.machineId),
    index("normalized_observations_host_idx").on(t.hostId),
  ],
);

/**
 * The unmapped-label worklist. Mutable by design: rows accumulate
 * occurrences, and humans resolve them to catalog SKUs. An observation that
 * lands here never reaches the pricing pipeline.
 */
export const unmappedLabels = pgTable(
  "unmapped_labels",
  {
    id: uuidPk(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id),
    rawGpuLabel: text("raw_gpu_label").notNull(),
    sampleRawObservationId: uuid("sample_raw_observation_id").references(() => rawObservations.id),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: "date" }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }).notNull(),
    occurrences: integer("occurrences").notNull().default(1),
    status: unmappedStatusEnum("status").notNull().default("open"),
    resolvedGpuId: text("resolved_gpu_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("unmapped_labels_provider_label_unique").on(t.providerId, t.rawGpuLabel)],
);

export const OBS_FINGERPRINT_VERSION = "v1";

/**
 * Deterministic dedup key over the fields that identify *the same published
 * row*: provider, provider's own row id, observation timestamp, label, unit,
 * region, gpu count. Raw price is deliberately excluded — a republished
 * corrected price for the same offer+timestamp should surface as a conflict,
 * not silently dedup away. Hashed (not stored plaintext) to keep the index
 * compact; the plaintext fields are all in the row anyway.
 */
export async function obsFingerprint(input: {
  providerSlug: string;
  sourceId: string | null;
  observedAt: Date;
  rawGpuLabel: string;
  rawUnit: string;
  region: string | null;
  gpuCount: number | null;
}): Promise<string> {
  const canonical = [
    OBS_FINGERPRINT_VERSION,
    input.providerSlug,
    input.sourceId ?? "",
    input.observedAt.toISOString(),
    input.rawGpuLabel,
    input.rawUnit,
    input.region ?? "",
    input.gpuCount === null ? "" : String(input.gpuCount),
  ].join("");
  return sha256Hex(canonical);
}

export type UnmappedReason = UnmappedRecord["reason"];
