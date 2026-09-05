/**
 * Network-free tests for the verification half of the auth boundary. Both
 * tokens are minted locally with jose against a locally generated ES256
 * keypair, and the public key is passed as the verification-key override —
 * `verifyAuthToken` and `getUser({idToken})` run their real verification
 * paths (SPKI import, ES256, issuer/audience/typ checks, linked_accounts
 * parsing) with zero Privy API traffic.
 */

import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { generateKeyPair, exportSPKI, SignJWT } from "jose";
import { parseServerEnv, getServerEnv } from "../env";
import { resolveWallet, verifyPrivySession } from "../privy-verify";

process.env.PRIVY_APP_ID = "test-app-id";
process.env.PRIVY_APP_SECRET = "test-app-secret";

const APP_ID = "test-app-id";
const USER_ID = "did:privy:test-user-1";
const SESSION_ID = "test-session-1";

let spki = "";
let privateKey: CryptoKey | null = null;

beforeAll(async () => {
  const pair = (await generateKeyPair("ES256", { extractable: true })) as {
    publicKey: CryptoKey;
    privateKey: CryptoKey;
  };
  privateKey = pair.privateKey;
  spki = await exportSPKI(pair.publicKey);
  // Seed the memoized client's offline key before any test runs.
  process.env.PRIVY_VERIFICATION_KEY = spki;
});

afterEach(() => {
  // Clear the memoized client between tests that toggle env.
});

/**
 * Mint a Privy-shaped token: ES256, typ JWT, issuer privy.io, audience appId.
 * verifyAuthToken projects the STANDARD claims — sub → userId, sid →
 * sessionId, iat/exp — so those are what get set; its custom
 * issuedAt/expiration fields are projections of them, not separate claims.
 */
function mint(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuer("privy.io")
    .setAudience(APP_ID)
    .sign(privateKey!);
}

function accessToken(exp = Math.floor(Date.now() / 1000) + 300): Promise<string> {
  return mint({
    sub: USER_ID,
    sid: SESSION_ID,
    iat: Math.floor(Date.now() / 1000) - 10,
    exp,
  });
}

/**
 * ID token: linked_accounts rides as a JSON string in the wire (snake_case)
 * shape, sub carries the user id, cr the account-creation epoch in seconds.
 */
function idToken(linkedAccounts: unknown[]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return mint({
    sub: USER_ID,
    cr: now - 3600,
    linked_accounts: JSON.stringify(linkedAccounts),
    iat: now - 10,
    exp: now + 300,
  });
}

/** Wire shape — the entries inside the ID token's linked_accounts string. */
const WIRE_EMBEDDED_WALLET = {
  type: "wallet",
  id: "embedded-1",
  address: "0xAbC0000000000000000000000000000000000001",
  chain_type: "ethereum",
  wallet_client_type: "privy",
  lv: Math.floor(Date.now() / 1000) - 60,
};

const WIRE_EXTERNAL_WALLET = {
  type: "wallet",
  id: "external-1",
  address: "0xDeF0000000000000000000000000000000000002",
  chain_type: "ethereum",
  wallet_client_type: "metamask",
  lv: Math.floor(Date.now() / 1000) - 30,
};

/** Parsed shape — User.linkedAccounts entries, what resolveWallet reads. */
const EMBEDDED_WALLET = {
  type: "wallet",
  id: "embedded-1",
  address: "0xAbC0000000000000000000000000000000000001",
  chainType: "ethereum",
  walletClientType: "privy",
  latestVerifiedAt: new Date(),
};

const EXTERNAL_WALLET = {
  type: "wallet",
  id: "external-1",
  address: "0xDeF0000000000000000000000000000000000002",
  chainType: "ethereum",
  walletClientType: "metamask",
  latestVerifiedAt: new Date(),
};

describe("parseServerEnv (auth boundary)", () => {
  it("treats absent Privy config as disabled", () => {
    const env = parseServerEnv({ NODE_ENV: "test" });
    expect(env.privyAppId).toBeNull();
    expect(env.privyAppSecret).toBeNull();
  });

  it("refuses a half-configured boundary", () => {
    expect(() => parseServerEnv({ NODE_ENV: "test", PRIVY_APP_ID: "x" })).toThrow(
      /PRIVY_APP_SECRET/,
    );
    expect(() => parseServerEnv({ NODE_ENV: "test", PRIVY_APP_SECRET: "y" })).toThrow(
      /PRIVY_APP_ID/,
    );
  });

  it("keeps the verification key optional", () => {
    const env = parseServerEnv({
      NODE_ENV: "test",
      PRIVY_APP_ID: "x",
      PRIVY_APP_SECRET: "y",
    });
    expect(env.privyVerificationKey).toBeNull();
  });
});

describe("resolveWallet", () => {
  it("prefers the external wallet and lowercases the address", () => {
    const wallet = resolveWallet({
      linkedAccounts: [EMBEDDED_WALLET, EXTERNAL_WALLET],
    } as never);
    expect(wallet?.address).toBe("0xdef0000000000000000000000000000000000002");
    expect(wallet?.walletKind).toBe("external");
    expect(wallet?.walletClientType).toBe("metamask");
  });

  it("falls back to the embedded wallet when no external exists", () => {
    const wallet = resolveWallet({
      linkedAccounts: [EMBEDDED_WALLET, { type: "email", address: "x@y.z" }],
    } as never);
    expect(wallet?.walletKind).toBe("embedded");
    expect(wallet?.address).toBe("0xabc0000000000000000000000000000000000001");
  });

  it("returns null when there is no wallet account yet", () => {
    expect(resolveWallet({ linkedAccounts: [{ type: "email" }] } as never)).toBeNull();
  });
});

describe("verifyPrivySession", () => {
  it("verifies a well-formed token pair end to end, offline", async () => {
    // Both wallets ride the ID token in wire shape; the real parser must
    // surface the external one as the resolved wallet.
    const session = await verifyPrivySession(
      await accessToken(),
      await idToken([WIRE_EMBEDDED_WALLET, WIRE_EXTERNAL_WALLET]),
    );
    expect(session.userId).toBe(USER_ID);
    expect(session.sessionId).toBe(SESSION_ID);
    expect(session.user.id).toBe(USER_ID);
    const wallet = resolveWallet(session.user);
    expect(wallet?.address).toBe("0xdef0000000000000000000000000000000000002");
    expect(wallet?.walletKind).toBe("external");
  });

  it("rejects a missing access token", async () => {
    await expect(verifyPrivySession(null, "id-token")).rejects.toMatchObject({
      name: "UnauthorizedError",
    });
  });

  it("rejects a missing identity token", async () => {
    await expect(verifyPrivySession(await accessToken(), null)).rejects.toMatchObject({
      name: "UnauthorizedError",
    });
  });

  it("rejects a token signed by the wrong key", async () => {
    const other = (await generateKeyPair("ES256", { extractable: true })) as {
      privateKey: CryptoKey;
    };
    const forged = await new SignJWT({
      appId: APP_ID,
      userId: USER_ID,
      sessionId: SESSION_ID,
    })
      .setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .setIssuer("privy.io")
      .setAudience(APP_ID)
      .sign(other.privateKey);
    await expect(verifyPrivySession(forged, await idToken([EXTERNAL_WALLET]))).rejects.toMatchObject({
      name: "UnauthorizedError",
    });
  });

  it("rejects an expired access token", async () => {
    const expired = await accessToken(Math.floor(Date.now() / 1000) - 60);
    await expect(verifyPrivySession(expired, await idToken([EXTERNAL_WALLET]))).rejects.toMatchObject(
      { name: "UnauthorizedError" },
    );
  });

  it("rejects an access token for the wrong audience", async () => {
    const wrongApp = await new SignJWT({
      appId: "other-app",
      userId: USER_ID,
      sessionId: SESSION_ID,
    })
      .setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .setIssuer("privy.io")
      .setAudience("other-app")
      .sign(privateKey!);
    await expect(verifyPrivySession(wrongApp, await idToken([EXTERNAL_WALLET]))).rejects.toMatchObject(
      { name: "UnauthorizedError" },
    );
  });

  it("rejects a bearer that fails verification even when the identity token is fine", async () => {
    // The identity token alone must never authenticate a request.
    await expect(verifyPrivySession("garbage", await idToken([EXTERNAL_WALLET]))).rejects.toMatchObject(
      { name: "UnauthorizedError" },
    );
  });

  it("exposes the env getter memoization", () => {
    expect(getServerEnv().privyAppId).toBe(APP_ID);
  });
});
