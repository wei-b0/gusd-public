/**
 * The API boundary's client half. Every identity-bearing request carries TWO
 * tokens — the access token (Bearer, proves the Privy session) and the
 * identity token (carries the linked accounts the server resolves the wallet
 * from). The body is never an identity source.
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
    const [accessToken, idToken] = await Promise.all([deps.getAccessToken(), deps.getIdentityToken()]);
    if (!accessToken || !idToken) return { headers: undefined, ok: false };
    return {
      ok: true,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Privy-Id-Token": idToken,
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
