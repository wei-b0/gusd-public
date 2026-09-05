/**
 * The auth boundary's verification half. Two tokens arrive per request:
 *
 *   - the access token (Bearer) proves an authenticated Privy session and
 *     yields `{ userId, sessionId }` — offline when PRIVY_VERIFICATION_KEY
 *     is configured (ES256 SPKI), else via Privy's API;
 *   - the identity token (X-Privy-Id-Token) is what carries the linked
 *     accounts; access-token claims do NOT contain a wallet address. It is
 *     optional app config — when the app doesn't issue identity tokens, the
 *     user is resolved from the verified access token's DID via Privy's API.
 *
 * The wallet address resolved here is the only identity the routes trust —
 * request bodies are never consulted for who the caller is.
 */

import { PrivyClient, type User, type WalletWithMetadata } from "@privy-io/server-auth";
import type { WalletKind } from "@gusd/types";
import { getServerEnv } from "./env";

/** The bearer/identity tokens were missing, invalid, or expired → 401. */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Authenticated, but the session has no wallet account yet → 422. */
export class WalletUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletUnresolvedError";
  }
}

export interface VerifiedSession {
  userId: string;
  sessionId: string;
  user: User;
}

let client: PrivyClient | null = null;

function getPrivyClient(): PrivyClient {
  const env = getServerEnv();
  if (!env.privyAppId || !env.privyAppSecret) {
    throw new Error("Privy is not configured on the server (PRIVY_APP_ID / PRIVY_APP_SECRET)");
  }
  if (!client) {
    client = new PrivyClient(env.privyAppId, env.privyAppSecret);
    if (env.privyVerificationKey) {
      // Seed the client's verification-key cache so ID-token verification
      // (getUser({idToken})) runs offline like verifyAuthToken does. This is
      // the same field the client's own getVerificationKey() consults first;
      // when the key is absent or the field moves, verification falls back
      // to the network path — degraded, not broken.
      (client as unknown as { verificationKey?: string }).verificationKey =
        env.privyVerificationKey;
    }
  }
  return client;
}

/**
 * Verify both tokens and return the Privy user. Throws UnauthorizedError
 * for every verification failure — the route maps it to one 401 shape, with
 * no signal about which half failed.
 */
export async function verifyPrivySession(
  accessToken: string | null,
  idToken: string | null,
): Promise<VerifiedSession> {
  if (!accessToken) throw new UnauthorizedError("Missing access token");
  const env = getServerEnv();
  const privy = getPrivyClient();

  let userId: string;
  let sessionId: string;
  try {
    const claims = await privy.verifyAuthToken(accessToken, env.privyVerificationKey ?? "");
    userId = claims.userId;
    sessionId = claims.sessionId;
  } catch {
    throw new UnauthorizedError("Invalid access token");
  }

  let user: User;
  if (!idToken) {
    // Identity tokens are a Privy dashboard opt-in ("Return user data in an
    // identity token"); until enabled, Privy issues none and every client
    // request arrives without one — getUserByIdentityToken has nothing to
    // read. The access token is already verified here, so resolving the user
    // by its DID is equally trusted, just not offline. Called once per
    // session sync, well under the API path's rate limits.
    try {
      user = await privy.getUser(userId);
    } catch {
      throw new UnauthorizedError("Could not resolve user");
    }
  } else {
    try {
      user = await privy.getUser({ idToken });
    } catch {
      throw new UnauthorizedError("Invalid identity token");
    }
  }

  return { userId, sessionId, user };
}

/**
 * Resolve the session's ONE wallet address from the verified user. Rule,
 * matching the client: external wallets win over embedded (Privy's email
 * dedupe can land an external wallet on an embedded user — the signer is
 * still exactly one), most recently linked first. Null when the user has no
 * wallet account at all (embedded still provisioning).
 */
export function resolveWallet(
  user: User,
): { address: string; walletKind: WalletKind; walletClientType: string | null } | null {
  const walletAccounts = user.linkedAccounts.filter(
    (a): a is WalletWithMetadata => a.type === "wallet" && typeof a.address === "string",
  );
  const external = walletAccounts.filter((a) => a.walletClientType !== "privy");
  const chosen = external.at(-1) ?? walletAccounts.at(-1);
  if (!chosen) return null;
  return {
    address: chosen.address.toLowerCase(),
    walletKind: chosen.walletClientType === "privy" ? "embedded" : "external",
    walletClientType: chosen.walletClientType ?? null,
  };
}
