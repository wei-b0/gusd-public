CREATE TYPE "public"."wallet_kind" AS ENUM('embedded', 'external');--> statement-breakpoint
CREATE TABLE "user_wallets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"privy_user_id" text NOT NULL,
	"address" varchar(42) NOT NULL,
	"wallet_kind" "wallet_kind" NOT NULL,
	"label" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_wallets_address_shape" CHECK ("user_wallets"."address" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_wallets_address_key" ON "user_wallets" USING btree ("address");--> statement-breakpoint
CREATE INDEX "user_wallets_privy_user_id_idx" ON "user_wallets" USING btree ("privy_user_id");