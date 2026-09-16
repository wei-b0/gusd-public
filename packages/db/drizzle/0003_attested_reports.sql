CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer NOT NULL,
	"gpu_id" text NOT NULL,
	"candidate_id" uuid,
	"price" bigint NOT NULL,
	"observed_at" bigint NOT NULL,
	"epoch" bigint NOT NULL,
	"valid_from" bigint NOT NULL,
	"valid_until" bigint NOT NULL,
	"calc_hash" text NOT NULL,
	"signature" text NOT NULL,
	"report_hash" text NOT NULL,
	"attested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "reports_gpu_epoch_unique" ON "reports" USING btree ("gpu_id","epoch");--> statement-breakpoint
CREATE INDEX "reports_gpu_attested_idx" ON "reports" USING btree ("gpu_id","attested_at" DESC);
