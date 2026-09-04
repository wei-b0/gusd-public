import type { BreakerMap } from "./types.js";

/**
 * Contributor source health, read from the oracle process — breaker state
 * lives in memory there, so HTTP is the only truthful view. Returns
 * slug → breakerOpen (a slug may run several collectors; any open breaker
 * marks the provider).
 */
export async function fetchBreakerMap(
  oracleUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs = 5_000,
): Promise<BreakerMap> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(new URL("/v1/health", oracleUrl), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (res.status !== 200) {
      throw new Error(`oracle health returned ${res.status}`);
    }
    const body = (await res.json()) as {
      collectors?: { collectorId: string; providerSlug: string; breakerOpen: boolean }[];
    };
    const map = new Map<string, boolean>();
    for (const c of body.collectors ?? []) {
      map.set(c.providerSlug, (map.get(c.providerSlug) ?? false) || c.breakerOpen);
    }
    return map;
  } finally {
    clearTimeout(timer);
  }
}
