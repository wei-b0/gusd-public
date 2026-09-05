/**
 * The API boundary's client half. Every identity-bearing request carries the
 * access token (Bearer — proves the Privy session); the identity token rides
 * along when the SDK has one (it carries the linked accounts the server
 * prefers to resolve the wallet from). The body is never an identity source.
 *
 * The identity token is optional: Privy only issues it when the dashboard
 * opts in, and its getter can throw (Privy rate-limits the endpoint it
 * refreshes against). Neither may break the request — the server resolves
 * the user from the verified Bearer's DID when the token is absent.
 *
 * On a 401 the token pair is fetched once more (Privy refreshes its access
 * token internally) and the request retries once; a second 401 is reported
 * to the caller, which marks the session expired — the UI says so, the user
 * reconnects on their terms. Nothing here force-logs-out.
 */

export interface AuthedFetchDeps {
  /** Current Privy access token (auto-refreshed by Privy). */
  getAccessToken: () => Promise<string | null>;
  /** Current Privy identity token. */
  getIdentityToken: () => Promise<string | null>;
}

export type AuthedFetch = (input: string, init?: RequestInit) => Promise<Response>;

export function createAuthedFetch(deps: AuthedFetchDeps): AuthedFetch {
  async function once(): Promise<{ headers: HeadersInit | undefined; ok: boolean }> {
    let accessToken: string | null = null;
    try {
      accessToken = await deps.getAccessToken();
    } catch {
      // A Privy-side failure (e.g. a 429) must degrade to "no tokens",
      // never escape as an unhandled rejection.
      return { headers: undefined, ok: false };
    }
    if (!accessToken) return { headers: undefined, ok: false };
    let idToken: string | null = null;
    try {
      idToken = await deps.getIdentityToken();
    } catch {
      idToken = null;
    }
    return {
      ok: true,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(idToken ? { "X-Privy-Id-Token": idToken } : {}),
      },
    };
  }

  return async (input, init) => {
    const first = await once();
    if (!first.ok) {
      // No tokens to present — the caller sees an unauthenticated 401.
      return fetch(input, init);
    }
    const res = await fetch(input, { ...init, headers: { ...init?.headers, ...first.headers } });
    if (res.status !== 401) return res;

    // One forced refresh + retry; a second 401 is the caller's signal.
    const second = await once();
    if (!second.ok) return res;
    return fetch(input, { ...init, headers: { ...init?.headers, ...second.headers } });
  };
}
