CREATE TABLE "publish_violations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"gpu_id" text NOT NULL,
	"target" text NOT NULL,
	"violations" jsonb NOT NULL,
	"publisher_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "publish_violations_candidate_target_unique" ON "publish_violations" USING btree ("candidate_id","target");--> statement-breakpoint
CREATE INDEX "publish_violations_gpu_idx" ON "publish_violations" USING btree ("gpu_id","created_at" DESC NULLS LAST);--> statement-breakpoint
-- publish_violations is an append-only ledger like every other market-data
-- table: refusals are part of the audit trail and are never rewritten.
CREATE TRIGGER publish_violations_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "publish_violations"
  FOR EACH STATEMENT EXECUTE FUNCTION gusd_forbid_mutation();