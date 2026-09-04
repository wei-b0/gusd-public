import {
  char,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, uuidPk } from "./common.js";

/**
 * FX rates: first-write-wins per (currency, rateDate). ON CONFLICT DO NOTHING
 * on insert — a rate is never corrected in place; a correction would be a new
 * methodology decision, not a silent overwrite. Staleness is handled by
 * holding out non-USD observations, never by guessing a rate.
 */
export const fxRates = pgTable(
  "fx_rates",
  {
    id: uuidPk(),
    currency: char("currency", { length: 3 }).notNull(),
    rateDate: date("rate_date").notNull(),
    usdPerUnit: numeric("usd_per_unit", { precision: 20, scale: 10, mode: "number" }).notNull(),
    source: text("source").notNull().default("ecb"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("fx_rates_currency_date_unique").on(t.currency, t.rateDate)],
);

/**
 * Watchdog feed snapshots (GPUPerHour, GPUTable, Inferra, Computable CGI).
 * Collected for comparison only — their numbers never enter the pricing
 * pipeline. `licenseNote` travels with the payload so redistribution
 * constraints are auditable at the row level.
 */
export const watchdogFeeds = pgTable(
  "watchdog_feeds",
  {
    id: uuidPk(),
    feed: text("feed").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    licenseNote: text("license_note").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("watchdog_feeds_feed_fetched_idx").on(t.feed, t.fetchedAt.desc())],
);

/** Deviation of a watchdog price from our latest healthy candidate. */
export const watchdogComparisons = pgTable(
  "watchdog_comparisons",
  {
    id: uuidPk(),
    feed: text("feed").notNull(),
    gpuId: text("gpu_id").notNull(),
    theirPrice: numeric("their_price", { precision: 12, scale: 4, mode: "number" }).notNull(),
    ourPrice: numeric("our_price", { precision: 12, scale: 4, mode: "number" }),
    deviationAbs: numeric("deviation_abs", { precision: 12, scale: 4, mode: "number" }).notNull(),
    deviationPct: numeric("deviation_pct", { precision: 12, scale: 8, mode: "number" }),
    comparedAt: timestamp("compared_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("watchdog_comparisons_feed_gpu_idx").on(t.feed, t.gpuId, t.comparedAt.desc())],
);
