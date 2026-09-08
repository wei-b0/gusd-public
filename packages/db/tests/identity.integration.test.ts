import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  createDb,
  findUserWalletByAddress,
  findUserWalletByPrivyUserId,
  upsertUserWallet,
  type Db,
} from "../src/index.js";

// DB integration tests are opt-in: RUN_DB_TESTS=1 pnpm --filter @gusd/db test
// (requires `pnpm stack:up` + `pnpm db:migrate`).
const run = process.env.RUN_DB_TESTS === "1";
const d = run ? describe : describe.skip;

const TEST_URL = process.env.DATABASE_URL
  ? new URL(process.env.DATABASE_URL)
  : new URL("postgres://gusd:gusd@localhost:54329/gusd");

function pgDetail(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur; i++) {
    parts.push(inspect(cur, { depth: 3 }));
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join("\n");
}

async function expectRejectionWithCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
    throw new Error(`expected rejection with code ${code}, but query succeeded`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("expected rejection with code")) throw err;
    expect(pgDetail(err)).toContain(code);
  }
}

const ADDRESS_A = "0xA1E2f3B4c5D6e7F8a9B0c1D2e3F4a5B6c7D8e9F0";
const ADDRESS_B = "0xB2f3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1";

d("user_wallets identity (RUN_DB_TESTS=1)", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    // Fresh throwaway database per test run, mirroring db.integration.test.ts.
    TEST_URL.pathname = "/postgres";
    const admin = new Pool({ connectionString: TEST_URL.toString() });
    try {
      await admin.query("DROP DATABASE IF EXISTS gusd_identity_test");
      await admin.query("CREATE DATABASE gusd_identity_test");
    } finally {
      await admin.end();
    }
    TEST_URL.pathname = "/gusd_identity_test";
    const handle = createDb(TEST_URL.toString());
    db = handle.db;
    close = handle.close;
    const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    await close();
    TEST_URL.pathname = "/postgres";
    const admin = new Pool({ connectionString: TEST_URL.toString() });
    try {
      await admin.query("DROP DATABASE IF EXISTS gusd_identity_test");
    } finally {
      await admin.end();
    }
  });

  it("inserts a new wallet row with defaults", async () => {
    const row = await upsertUserWallet(db, {
      privyUserId: "did:privy:test-user-1",
      address: ADDRESS_A,
      walletKind: "embedded",
    });
    expect(row.address).toBe(ADDRESS_A.toLowerCase());
    expect(row.walletKind).toBe("embedded");
    expect(row.label).toBeNull();
    expect(row.firstSeenAt).toBeInstanceOf(Date);
    expect(row.lastSeenAt).toBeInstanceOf(Date);
  });

  it("normalizes mixed-case addresses to one canonical row", async () => {
    const row = await upsertUserWallet(db, {
      privyUserId: "did:privy:test-user-1",
      address: ADDRESS_A,
      walletKind: "external",
    });
    expect(row.address).toBe(ADDRESS_A.toLowerCase());
    const count = await db.execute(
      sql`select count(*)::int as n from user_wallets where address = ${ADDRESS_A.toLowerCase()}`,
    );
    expect(count.rows[0]).toMatchObject({ n: 1 });
  });

  it("re-auth bumps last_seen_at and keeps exactly one row", async () => {
    const before = await findUserWalletByAddress(db, ADDRESS_A);
    expect(before).not.toBeNull();
    const firstSeen = before!.firstSeenAt;
    const lastSeenBefore = before!.lastSeenAt;

    // Wait past timestamp resolution so the bump is observable.
    await new Promise((r) => setTimeout(r, 15));
    await upsertUserWallet(db, {
      privyUserId: "did:privy:test-user-1",
      address: ADDRESS_A.toLowerCase(),
      walletKind: "external",
      label: "0xa1e2…e9f0",
    });

    const after = await findUserWalletByAddress(db, ADDRESS_A);
    expect(after!.id).toBe(before!.id);
    expect(after!.lastSeenAt.getTime()).toBeGreaterThan(lastSeenBefore.getTime());
    expect(after!.firstSeenAt.getTime()).toBe(firstSeen.getTime());
    expect(after!.label).toBe("0xa1e2…e9f0");
  });

  it("a different wallet is a different account (no cross-wallet rows)", async () => {
    await upsertUserWallet(db, {
      privyUserId: "did:privy:test-user-2",
      address: ADDRESS_B,
      walletKind: "external",
    });
    const a = await findUserWalletByAddress(db, ADDRESS_A);
    const b = await findUserWalletByAddress(db, ADDRESS_B);
    expect(a!.privyUserId).toBe("did:privy:test-user-1");
    expect(b!.privyUserId).toBe("did:privy:test-user-2");
  });

  it("wallet re-auth under a new provider DID reassigns, never duplicates", async () => {
    await upsertUserWallet(db, {
      privyUserId: "did:privy:brand-new-identity",
      address: ADDRESS_B,
      walletKind: "external",
    });
    const row = await findUserWalletByAddress(db, ADDRESS_B);
    expect(row!.privyUserId).toBe("did:privy:brand-new-identity");
    const byOldDid = await findUserWalletByPrivyUserId(db, "did:privy:test-user-2");
    expect(byOldDid).toBeNull();
  });

  it("rejects malformed addresses at the boundary", async () => {
    await expectRejectionWithCode(
      upsertUserWallet(db, {
        privyUserId: "did:privy:test-bad",
        address: "0x1234", // too short
        walletKind: "external",
      }),
      "user_wallets_address_shape",
    );
  });

  it("the check constraint holds even against raw inserts (uppercase fails)", async () => {
    // The repo normalizes case; the DB is the backstop for anything that
    // bypasses it — an uppercase address violates the lowercase-only shape.
    try {
      await db.execute(
        sql`insert into user_wallets (id, privy_user_id, address, wallet_kind)
            values (gen_random_uuid(), 'did:privy:test-raw', ${"0x" + "F".repeat(40)}, 'external')`,
      );
      throw new Error("expected raw uppercase insert to be rejected");
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("expected raw uppercase")) throw err;
      // Walk the drizzle error wrapper down to the PG error's code.
      let code: unknown;
      let cur: unknown = err;
      for (let i = 0; i < 8 && cur && code === undefined; i++) {
        code = (cur as { code?: unknown }).code;
        cur = (cur as { cause?: unknown }).cause;
      }
      expect(code).toBe("23514");
    }
  });
});
