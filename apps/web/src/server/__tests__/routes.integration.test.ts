/**
 * Route-level integration for the auth boundary (RUN_DB_TESTS=1): mints
 * Privy-shaped tokens against a locally generated ES256 key and drives the
 * real route handlers over Request/Response objects — no HTTP server, no
 * Privy network (the verification key IS the local public key).
 *
 * Targets the dev identity database (docker compose gusd@54329, migrations
 * applied) — the upsert is idempotent, so re-runs reuse the row. Rows carry
 * a `did:privy:routes-smoke` prefix; clear them with:
 *   docker exec gusd-postgres psql -U gusd -d gusd \
 *     -c "delete from user_wallets where privy_user_id like 'did:privy:routes-smoke%'"
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importPKCS8, SignJWT } from "jose";
import { readFileSync } from "node:fs";
import { createDb, findUserWalletByAddress, type Db } from "@gusd/db";
import { POST as sessionPost } from "@/app/api/auth/session/route";
import { GET as meGet } from "@/app/api/me/route";

const run = process.env.RUN_DB_TESTS === "1";
const d = run ? describe : describe.skip;

const APP_ID = "smokedummyappid1234567890";
const SMOKE_DID = `did:privy:routes-smoke-${Date.now()}`;
const ADDRESS = "0xDeF0000000000000000000000000000000000002";

/** Wire-shaped wallet account riding the ID token. */
const WIRE_WALLET = {
  type: "wallet",
  id: "smoke-wallet-1",
  address: ADDRESS,
  chain_type: "ethereum",
  wallet_client_type: "metamask",
  lv: 0,
};

d("auth boundary routes (RUN_DB_TESTS=1)", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    // The smoke keypair is minted next to this suite by the run harness; the
    // env points the server at it so both verify paths run fully offline.
    process.env.PRIVY_APP_ID = APP_ID;
    process.env.PRIVY_APP_SECRET = "smoke-secret";
    process.env.PRIVY_VERIFICATION_KEY = readFileSync("/tmp/gusd-smoke/spki.pem", "utf8");
    process.env.DATABASE_URL ??= "postgres://gusd:gusd@localhost:54329/gusd";
    const handle = createDb(process.env.DATABASE_URL);
    db = handle.db;
    close = handle.close;
  });

  afterAll(async () => {
    await close?.();
  });

  /** Mint a fresh token pair for the smoke user. */
  async function tokenPair(): Promise<{ authorization: string; idToken: string }> {
    const key = await importPKCS8(readFileSync("/tmp/gusd-smoke/priv.pem", "utf8"), "ES256");
    const now = Math.floor(Date.now() / 1000);
    const sign = (payload: Record<string, unknown>) =>
      new SignJWT(payload)
        .setProtectedHeader({ alg: "ES256", typ: "JWT" })
        .setIssuer("privy.io")
        .setAudience(APP_ID)
        .sign(key);
    const accessToken = await sign({
      sub: SMOKE_DID,
      sid: "smoke-session",
      iat: now - 10,
      exp: now + 600,
    });
    const idToken = await sign({
      sub: SMOKE_DID,
      cr: now - 3600,
      linked_accounts: JSON.stringify([WIRE_WALLET]),
      iat: now - 10,
      exp: now + 600,
    });
    return { authorization: `Bearer ${accessToken}`, idToken };
  }

  function post(body: unknown, headers: Record<string, string>): Promise<Response> {
    return sessionPost(
      new Request("http://test.local/api/auth/session", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  }

  function get(headers: Record<string, string>): Promise<Response> {
    return meGet(new Request("http://test.local/api/me", { headers }));
  }

  it("rejects a request with no tokens", async () => {
    const res = await post({ address: ADDRESS }, {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("rejects garbage tokens", async () => {
    const res = await post({ address: ADDRESS }, {
      authorization: "Bearer garbage",
      "x-privy-id-token": "garbage",
    });
    expect(res.status).toBe(401);
  });

  it("never trusts the body for identity", async () => {
    const { authorization, idToken } = await tokenPair();
    // A body claiming a different address is ignored: the verified identity
    // token decides, and the response carries ITS wallet.
    const res = await post({ address: "0x1111111111111111111111111111111111111111" }, {
      authorization,
      "x-privy-id-token": idToken,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { address: string; walletKind: string; label: string };
    expect(data.address).toBe(ADDRESS.toLowerCase());
    expect(data.walletKind).toBe("external");
    expect(data.label).toBe("0xdef0…0002");
  });

  it("round-trips: re-auth maps back to the same row", async () => {
    const { authorization, idToken } = await tokenPair();
    const first = await post({}, { authorization, "x-privy-id-token": idToken });
    expect(first.status).toBe(200);
    const a = (await first.json()) as { firstSeenAt: string; lastSeenAt: string };

    const second = await post({}, { authorization, "x-privy-id-token": idToken });
    const b = (await second.json()) as { firstSeenAt: string; lastSeenAt: string };
    expect(b.firstSeenAt).toBe(a.firstSeenAt);

    const row = await findUserWalletByAddress(db, ADDRESS.toLowerCase());
    expect(row?.privyUserId).toBe(SMOKE_DID);
    expect(row?.walletKind).toBe("external");
  });

  it("GET /api/me reads the registered wallet", async () => {
    const { authorization, idToken } = await tokenPair();
    const res = await get({ authorization, "x-privy-id-token": idToken });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { address: string; walletKind: string };
    expect(data.address).toBe(ADDRESS.toLowerCase());
    expect(data.walletKind).toBe("external");
  });

  it("GET /api/me rejects garbage tokens", async () => {
    const res = await get({ authorization: "Bearer garbage", "x-privy-id-token": "garbage" });
    expect(res.status).toBe(401);
  });
});
