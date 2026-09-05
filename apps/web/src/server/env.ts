/**
 * Server-side environment, parsed once, fail-closed in the publisher's house
 * style: a half-configured auth boundary must not boot. PRIVY_APP_ID without
 * PRIVY_APP_SECRET is a boot error, not a silent fallback.
 *
 * Note: this module is server-only (Node runtime route handlers). It reads
 * PRIVY_APP_SECRET — never import it from client components.
 */

export interface ServerEnv {
  /** Privy app id, or null when the auth boundary is not configured. */
  privyAppId: string | null;
  /** Privy app secret; required whenever privyAppId is set. */
  privyAppSecret: string | null;
  /** Offline verification key (SPKI PEM). Preferred over network verification. */
  privyVerificationKey: string | null;
  databaseUrl: string;
}

const DEFAULT_DATABASE_URL = "postgres://gusd:gusd@localhost:54329/gusd";

export function parseServerEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv {
  const privyAppId = env.PRIVY_APP_ID?.trim() || null;
  const privyAppSecret = env.PRIVY_APP_SECRET?.trim() || null;
  if (privyAppId && !privyAppSecret) {
    throw new Error("PRIVY_APP_SECRET is required when PRIVY_APP_ID is set");
  }
  if (!privyAppId && privyAppSecret) {
    throw new Error("PRIVY_APP_SECRET is set without PRIVY_APP_ID");
  }
  const privyVerificationKey = env.PRIVY_VERIFICATION_KEY?.trim() || null;
  return {
    privyAppId,
    privyAppSecret,
    privyVerificationKey,
    databaseUrl: env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL,
  };
}

let cached: ServerEnv | null = null;

/** Memoized parse; first call validates. */
export function getServerEnv(): ServerEnv {
  if (!cached) cached = parseServerEnv();
  return cached;
}
