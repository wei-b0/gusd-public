import { sql } from "drizzle-orm";
import {
  boolean,
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
import type { ProviderPriceResult } from "@gusd/types";
import { createdAt, uuidPk } from "./common.js";
import { indexStatusEnum, providerPriceMethodEnum } from "./enums.js";
import { providers } from "./providers.js";

/**
 * Per-provider aggregation output: ONE economic contribution per provider per
 * gpu per window. `price` null means the provider was deliberately held out
 * (thin book, no USD observations) — a held-out provider is recorded, never
 * silently absent. Append-only.
 */
export const providerPrices = pgTable(
  "provider_prices",
  {
    id: uuidPk(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id),
    gpuId: text("gpu_id").notNull(),
    panelId: text("panel_id"),
    /** null = held out this window. */
    price: numeric("price", { precision: 12, scale: 4, mode: "number" }),
    method: providerPriceMethodEnum("method").notNull(),
    /**
     * True when the price came from an executable order book that met depth
     * floors; false for static rate cards. Drives the engine weight (1.0 vs
     * 0.6) — keyed on this explicit flag, not on sourceType.
     */
    executable: boolean("executable").notNull(),
    sampleSize: integer("sample_size").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true, mode: "date" }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true, mode: "date" }).notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "date" }).notNull(),
    methodologyVersion: text("methodology_version").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    receipts: jsonb("receipts").$type<ProviderPriceResult["receipts"]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("provider_prices_gpu_computed_idx").on(t.gpuId, t.computedAt.desc()),
    index("provider_prices_provider_gpu_idx").on(t.providerId, t.gpuId, t.computedAt.desc()),
  ],
);

/**
 * Index output per computation. Append-only; "the latest candidate" is the
 * row with max computedAt per gpu — supersession is derived at read time, not
 * written back (any UPDATE would break append-only).
 *
 * `price` is non-null even for `withheld` (the computed value is stored for
 * audit, gated from publication); null price only for empty computations.
 */
export const indexCandidates = pgTable(
  "index_candidates",
  {
    id: uuidPk(),
    gpuId: text("gpu_id").notNull(),
    panelId: text("panel_id").notNull(),
    price: numeric("price", { precision: 12, scale: 4, mode: "number" }),
    confidenceLow: numeric("confidence_low", { precision: 12, scale: 4, mode: "number" }),
    confidenceHigh: numeric("confidence_high", { precision: 12, scale: 4, mode: "number" }),
    dispersion: numeric("dispersion", { precision: 12, scale: 8, mode: "number" }).notNull(),
    status: indexStatusEnum("status").notNull(),
    providersObserved: integer("providers_observed").notNull(),
    providersContributing: integer("providers_contributing").notNull(),
    methodologyVersion: text("methodology_version").notNull(),
    gates: jsonb("gates").$type<unknown[]>().notNull(),
    contributors: jsonb("contributors").$type<unknown[]>().notNull(),
    exclusions: jsonb("exclusions").$type<unknown[]>().notNull(),
    calcParams: jsonb("calc_params").$type<Record<string, unknown>>().notNull(),
    /** sha256(canonicalJson(receipt)) — the byte-stable identity of this computation. */
    calcHash: text("calc_hash").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true, mode: "date" }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true, mode: "date" }).notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Set ONLY on `stale` rows: the prior candidate whose price is carried forward. */
    priorCandidateId: uuid("prior_candidate_id"),
    createdAt: createdAt(),
  },
  (t) => [
    // A byte-identical recomputation is the same fact, not a new one. Stale
    // rows carry forward an old price and may legitimately repeat.
    uniqueIndex("index_candidates_gpu_calchash_unique")
      .on(t.gpuId, t.calcHash)
      .where(sql`status <> 'stale'`),
    index("index_candidates_gpu_computed_idx").on(t.gpuId, t.computedAt.desc()),
  ],
);

/**
 * Publication ledger. Unique (candidateId, target) makes publishing
 * idempotent: the publisher can crash after the target acknowledges and the
 * retry is a no-op read of this row.
 */
export const publishedIndexValues = pgTable(
  "published_index_values",
  {
    id: uuidPk(),
    candidateId: uuid("candidate_id").notNull(),
    gpuId: text("gpu_id").notNull(),
    panelId: text("panel_id").notNull(),
    price: numeric("price", { precision: 12, scale: 4, mode: "number" }).notNull(),
    confidenceLow: numeric("confidence_low", { precision: 12, scale: 4, mode: "number" }),
    confidenceHigh: numeric("confidence_high", { precision: 12, scale: 4, mode: "number" }),
    status: indexStatusEnum("status").notNull(),
    publisherVersion: text("publisher_version").notNull(),
    target: text("target").notNull(),
    txRef: text("tx_ref").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("published_index_values_candidate_target_unique").on(t.candidateId, t.target),
    index("published_index_values_gpu_published_idx").on(t.gpuId, t.publishedAt.desc()),
  ],
);

/**
 * Rejected publication attempts: the validator's refusal record. A candidate
 * that fails validation is a durable fact about the market state — withheld is
 * safer than fabricated, and the rejection must be auditable, not just logged.
 * Unique (candidateId, target): a rejected candidate stays rejected; a later
 * re-evaluation of the same bytes is not new evidence. Append-only.
 */
export const publishViolations = pgTable(
  "publish_violations",
  {
    id: uuidPk(),
    candidateId: uuid("candidate_id").notNull(),
    gpuId: text("gpu_id").notNull(),
    target: text("target").notNull(),
    violations: jsonb("violations").$type<{ code: string; detail: string }[]>().notNull(),
    publisherVersion: text("publisher_version").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("publish_violations_candidate_target_unique").on(t.candidateId, t.target),
    index("publish_violations_gpu_idx").on(t.gpuId, t.createdAt.desc()),
  ],
);

/**
 * Methodology configuration registry. Never mutated: a methodology change is
 * a new row with a new version and effectiveFrom. Exactly one row may be
 * current (effectiveTo null) — enforced by a partial unique index added in
 * the guards migration.
 */
export const methodologyVersions = pgTable(
  "methodology_versions",
  {
    id: uuidPk(),
    version: text("version").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    configHash: text("config_hash").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true, mode: "date" }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true, mode: "date" }),
    changelog: text("changelog"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("methodology_versions_version_unique").on(t.version)],
);
