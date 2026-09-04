import { timestamp, uuid } from "drizzle-orm/pg-core";
import { newId } from "@gusd/types/ids";

/**
 * Shared column builders. Primary keys are application-generated UUIDv7
 * (`$defaultFn(newId)`): lexicographically time-ordered, and minted on the
 * write path so id assignment is visible in receipts and logs — the DB never
 * issues an id the app did not choose first.
 */
export const uuidPk = () => uuid("id").primaryKey().$defaultFn(() => newId());

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
