import { jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { CadenceTier, ProviderRole, SourceType } from "@gusd/types";
import { createdAt, uuidPk } from "./common.js";
import { cadenceTierEnum, providerRoleEnum, sourceTypeEnum } from "./enums.js";

/**
 * The provider registry. Seeded idempotently from the static collector
 * registry at oracle startup; `role` here is the single source of truth the
 * pricing engine filters on — collection breadth and settlement eligibility
 * are deliberately decoupled.
 */
export const providers = pgTable(
  "providers",
  {
    id: uuidPk(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    sourceType: sourceTypeEnum("source_type").notNull(),
    role: providerRoleEnum("role").notNull(),
    cadenceTier: cadenceTierEnum("cadence_tier").notNull(),
    homepageUrl: text("homepage_url"),
    /**
     * Provider-specific engine/verification configuration (order-book depth
     * floors, region screens, executable-flag overrides, panel memberships).
     * Written by humans via migration/seed, read by the engine — never by
     * collectors.
     */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("providers_slug_unique").on(t.slug)],
);

/** A row to seed the providers table from the static collector registry. */
export interface ProviderSeed {
  slug: string;
  name: string;
  sourceType: SourceType;
  role: ProviderRole;
  cadenceTier: CadenceTier;
  homepageUrl?: string;
  config?: Record<string, unknown>;
}
