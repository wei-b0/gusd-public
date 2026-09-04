import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { RunStatus } from "@gusd/types";
import { createdAt, uuidPk } from "./common.js";
import { failureKindEnum, runStatusEnum } from "./enums.js";
import { providers } from "./providers.js";

/**
 * One terminal row per collector invocation. Mutable (a run starts, then
 * finishes) but never deleted; it is the join point between the scheduler and
 * the observation tables.
 */
export const collectionRuns = pgTable(
  "collection_runs",
  {
    id: uuidPk(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id),
    /** Collector implementation id (equals provider slug today; decoupled for future multi-collector providers). */
    collectorId: text("collector_id").notNull(),
    trigger: text("trigger").notNull(), // scheduled | manual | replay
    attempt: integer("attempt").notNull().default(1),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    durationMs: integer("duration_ms"),
    status: runStatusEnum("status").notNull(),
    rawCount: integer("raw_count").notNull().default(0),
    normalizedCount: integer("normalized_count").notNull().default(0),
    unmappedCount: integer("unmapped_count").notNull().default(0),
    failureKind: failureKindEnum("failure_kind"),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
  },
  (t) => [index("collection_runs_provider_started_idx").on(t.providerId, t.startedAt.desc())],
);

/**
 * Append-only failure ledger. The circuit breaker rehydrates its
 * consecutive-failure streak from this table after a restart, so breaker
 * state survives process death without any mutable breaker table.
 */
export const sourceFailures = pgTable(
  "source_failures",
  {
    id: uuidPk(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id),
    collectorId: text("collector_id").notNull(),
    collectionRunId: uuid("collection_run_id").references(() => collectionRuns.id),
    failureKind: failureKindEnum("failure_kind").notNull(),
    detail: text("detail"),
    retryAfterSeconds: integer("retry_after_seconds"),
    circuitOpened: boolean("circuit_opened").notNull().default(false),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("source_failures_provider_occurred_idx").on(t.providerId, t.occurredAt.desc())],
);
