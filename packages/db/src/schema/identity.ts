import { check, index, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createdAt, uuidPk } from "./common.js";
import { walletKindEnum } from "./enums.js";

/**
 * Identity boundary for the auth/wallet layer.
 *
 * One row per wallet. The unique index on `address` is what makes the
 * product's 1 user = 1 wallet invariant true at rest: a wallet that
 * re-authenticates (even under a different provider identity) maps back to
 * its existing row instead of duplicating, and a second wallet is always a
 * second gUSD account — never linked here.
 *
 * PII rule: `label` holds an address-derived display label only. Emails and
 * other personal data stay inside the auth provider; nothing in this table
 * is a direct identifier of a human.
 */
export const userWallets = pgTable(
  "user_wallets",
  {
    id: uuidPk(),
    createdAt: createdAt(),
    /** Auth-provider user DID (did:privy:…). The wallet is the row's key
     *  truth; this is reassigned if the wallet re-authenticates under a
     *  different provider identity. */
    privyUserId: text("privy_user_id").notNull(),
    /** Lowercase hex address (the check enforces the shape; writers
     *  normalize case). Unique: one wallet = one row = one user. */
    address: varchar("address", { length: 42 }).notNull(),
    walletKind: walletKindEnum("wallet_kind").notNull(),
    /** Address-derived display label (e.g. 0x1234…abcd). Never PII. */
    label: text("label"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("user_wallets_address_key").on(t.address),
    index("user_wallets_privy_user_id_idx").on(t.privyUserId),
    check(
      "user_wallets_address_shape",
      sql`${t.address} ~ '^0x[0-9a-f]{40}$'`,
    ),
  ],
);
