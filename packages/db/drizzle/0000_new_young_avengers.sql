CREATE TYPE "public"."cadence_tier" AS ENUM('FAST', 'MEDIUM', 'SLOW');--> statement-breakpoint
CREATE TYPE "public"."failure_kind" AS ENUM('network', 'parse', 'timeout', 'rate_limited', 'auth_failed', 'empty_result', 'insufficient_data', 'schema_drift', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."index_status" AS ENUM('healthy', 'degraded', 'stale', 'withheld', 'frozen');--> statement-breakpoint
CREATE TYPE "public"."pricing_tier" AS ENUM('on_demand', 'community', 'spot', 'preemptible', 'reserved', 'committed');--> statement-breakpoint
CREATE TYPE "public"."provider_price_method" AS ENUM('median', 'volume_weighted_median', 'thin_book_holdout');--> statement-breakpoint
CREATE TYPE "public"."provider_role" AS ENUM('COLLECTED', 'SETTLEMENT_ELIGIBLE', 'WATCHDOG_ONLY', 'EXCLUDED');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('success', 'partial', 'failed', 'skipped', 'circuit_open');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('principal', 'marketplace', 'reseller', 'aggregator');--> statement-breakpoint
CREATE TYPE "public"."unmapped_status" AS ENUM('open', 'mapped', 'ignored');--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"source_type" "source_type" NOT NULL,
	"role" "provider_role" NOT NULL,
	"cadence_tier" "cadence_tier" NOT NULL,
	"homepage_url" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_id" uuid NOT NULL,
	"collector_id" text NOT NULL,
	"trigger" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"status" "run_status" NOT NULL,
	"raw_count" integer DEFAULT 0 NOT NULL,
	"normalized_count" integer DEFAULT 0 NOT NULL,
	"unmapped_count" integer DEFAULT 0 NOT NULL,
	"failure_kind" "failure_kind",
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_failures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_id" uuid NOT NULL,
	"collector_id" text NOT NULL,
	"collection_run_id" uuid,
	"failure_kind" "failure_kind" NOT NULL,
	"detail" text,
	"retry_after_seconds" integer,
	"circuit_opened" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "normalized_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"raw_observation_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"source_type" "source_type" NOT NULL,
	"gpu_id" text NOT NULL,
	"usd_per_gpu_hour" numeric(12, 4) NOT NULL,
	"pricing_tier" "pricing_tier" NOT NULL,
	"gpu_count" integer,
	"region" text,
	"available" boolean,
	"offer_id" text,
	"machine_id" text,
	"host_id" text,
	"raw_total_usd_per_hour" numeric(20, 8),
	"is_bid" boolean DEFAULT false NOT NULL,
	"fx_rate_used" numeric(20, 10),
	"fx_rate_date" date,
	"normalization_version" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"collection_run_id" uuid,
	"provider_id" uuid NOT NULL,
	"source_type" "source_type" NOT NULL,
	"raw_gpu_label" text NOT NULL,
	"raw_price" numeric(20, 8),
	"raw_currency" char(3) NOT NULL,
	"raw_unit" text NOT NULL,
	"gpu_count" integer,
	"region" text,
	"pricing_tier" "pricing_tier",
	"observed_at" timestamp with time zone NOT NULL,
	"source_url" text,
	"source_id" text,
	"raw_payload" jsonb NOT NULL,
	"obs_fingerprint" text NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unmapped_labels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_id" uuid NOT NULL,
	"raw_gpu_label" text NOT NULL,
	"sample_raw_observation_id" uuid,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"status" "unmapped_status" DEFAULT 'open' NOT NULL,
	"resolved_gpu_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "index_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gpu_id" text NOT NULL,
	"panel_id" text NOT NULL,
	"price" numeric(12, 4),
	"confidence_low" numeric(12, 4),
	"confidence_high" numeric(12, 4),
	"dispersion" numeric(12, 8) NOT NULL,
	"status" "index_status" NOT NULL,
	"providers_observed" integer NOT NULL,
	"providers_contributing" integer NOT NULL,
	"methodology_version" text NOT NULL,
	"gates" jsonb NOT NULL,
	"contributors" jsonb NOT NULL,
	"exclusions" jsonb NOT NULL,
	"calc_params" jsonb NOT NULL,
	"calc_hash" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"prior_candidate_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "methodology_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"config" jsonb NOT NULL,
	"config_hash" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"changelog" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_id" uuid NOT NULL,
	"gpu_id" text NOT NULL,
	"panel_id" text,
	"price" numeric(12, 4),
	"method" "provider_price_method" NOT NULL,
	"executable" boolean NOT NULL,
	"sample_size" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"methodology_version" text NOT NULL,
	"params" jsonb NOT NULL,
	"receipts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_index_values" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"gpu_id" text NOT NULL,
	"panel_id" text NOT NULL,
	"price" numeric(12, 4) NOT NULL,
	"confidence_low" numeric(12, 4),
	"confidence_high" numeric(12, 4),
	"status" "index_status" NOT NULL,
	"publisher_version" text NOT NULL,
	"target" text NOT NULL,
	"tx_ref" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"currency" char(3) NOT NULL,
	"rate_date" date NOT NULL,
	"usd_per_unit" numeric(20, 10) NOT NULL,
	"source" text DEFAULT 'ecb' NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchdog_comparisons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"feed" text NOT NULL,
	"gpu_id" text NOT NULL,
	"their_price" numeric(12, 4) NOT NULL,
	"our_price" numeric(12, 4),
	"deviation_abs" numeric(12, 4) NOT NULL,
	"deviation_pct" numeric(12, 8),
	"compared_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchdog_feeds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"feed" text NOT NULL,
	"payload" jsonb NOT NULL,
	"license_note" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collection_runs" ADD CONSTRAINT "collection_runs_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_failures" ADD CONSTRAINT "source_failures_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_failures" ADD CONSTRAINT "source_failures_collection_run_id_collection_runs_id_fk" FOREIGN KEY ("collection_run_id") REFERENCES "public"."collection_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "normalized_observations" ADD CONSTRAINT "normalized_observations_raw_observation_id_raw_observations_id_fk" FOREIGN KEY ("raw_observation_id") REFERENCES "public"."raw_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "normalized_observations" ADD CONSTRAINT "normalized_observations_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_observations" ADD CONSTRAINT "raw_observations_collection_run_id_collection_runs_id_fk" FOREIGN KEY ("collection_run_id") REFERENCES "public"."collection_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_observations" ADD CONSTRAINT "raw_observations_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmapped_labels" ADD CONSTRAINT "unmapped_labels_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmapped_labels" ADD CONSTRAINT "unmapped_labels_sample_raw_observation_id_raw_observations_id_fk" FOREIGN KEY ("sample_raw_observation_id") REFERENCES "public"."raw_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_prices" ADD CONSTRAINT "provider_prices_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "providers_slug_unique" ON "providers" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "collection_runs_provider_started_idx" ON "collection_runs" USING btree ("provider_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "source_failures_provider_occurred_idx" ON "source_failures" USING btree ("provider_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "normalized_observations_raw_unique" ON "normalized_observations" USING btree ("raw_observation_id");--> statement-breakpoint
CREATE INDEX "normalized_observations_gpu_observed_idx" ON "normalized_observations" USING btree ("gpu_id","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "normalized_observations_provider_gpu_idx" ON "normalized_observations" USING btree ("provider_id","gpu_id","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "normalized_observations_machine_idx" ON "normalized_observations" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "normalized_observations_host_idx" ON "normalized_observations" USING btree ("host_id");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_observations_fingerprint_unique" ON "raw_observations" USING btree ("obs_fingerprint");--> statement-breakpoint
CREATE INDEX "raw_observations_provider_observed_idx" ON "raw_observations" USING btree ("provider_id","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "unmapped_labels_provider_label_unique" ON "unmapped_labels" USING btree ("provider_id","raw_gpu_label");--> statement-breakpoint
CREATE UNIQUE INDEX "index_candidates_gpu_calchash_unique" ON "index_candidates" USING btree ("gpu_id","calc_hash") WHERE status <> 'stale';--> statement-breakpoint
CREATE INDEX "index_candidates_gpu_computed_idx" ON "index_candidates" USING btree ("gpu_id","computed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "methodology_versions_version_unique" ON "methodology_versions" USING btree ("version");--> statement-breakpoint
CREATE INDEX "provider_prices_gpu_computed_idx" ON "provider_prices" USING btree ("gpu_id","computed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "provider_prices_provider_gpu_idx" ON "provider_prices" USING btree ("provider_id","gpu_id","computed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "published_index_values_candidate_target_unique" ON "published_index_values" USING btree ("candidate_id","target");--> statement-breakpoint
CREATE INDEX "published_index_values_gpu_published_idx" ON "published_index_values" USING btree ("gpu_id","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_currency_date_unique" ON "fx_rates" USING btree ("currency","rate_date");--> statement-breakpoint
CREATE INDEX "watchdog_comparisons_feed_gpu_idx" ON "watchdog_comparisons" USING btree ("feed","gpu_id","compared_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "watchdog_feeds_feed_fetched_idx" ON "watchdog_feeds" USING btree ("feed","fetched_at" DESC NULLS LAST);
-- ---------------------------------------------------------------------------
-- gUSD guards: append-only enforcement + methodology single-current invariant
-- ---------------------------------------------------------------------------
-- Raw market data, derivations, and publications are facts, not state: they
-- are written once and never mutated. Enforcement is doubled — these triggers
-- plus (in production) an app role granted INSERT/SELECT only.

CREATE OR REPLACE FUNCTION gusd_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %.%: % is not permitted',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'raw_observations',
    'normalized_observations',
    'provider_prices',
    'index_candidates',
    'published_index_values',
    'source_failures',
    'fx_rates'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION gusd_forbid_mutation()',
      t, t
    );
  END LOOP;
END;
$$;

-- At most one current methodology configuration may exist.
CREATE UNIQUE INDEX methodology_versions_one_current_unique
  ON methodology_versions ((TRUE))
  WHERE effective_to IS NULL;
