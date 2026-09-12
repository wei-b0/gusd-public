/**
 * The indexer client — the one IndexerPort implementation, inert until
 * Envio ships. With NEXT_PUBLIC_INDEXER_URL absent, isIndexed is false
 * and getUserEvents resolves null without touching the network (asserted
 * in the unit suite). With the URL configured, it speaks the wire contract
 * documented in src/domain/indexer.ts against the oracle protocol API; any
 * failure — unreachable, slow, malformed — resolves to null, because
 * indexing lag is never an error state.
 */

import type { IndexerPort, IndexedEvent, IndexedEventsQuery } from "@/domain/indexer";
import { getActiveChain } from "@/data/web3/chains";

/** Read lazily so tests can stub the env without import juggling. */
function indexerUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_INDEXER_URL;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/** An indexer that doesn't answer within this is treated as absent. */
const TIMEOUT_MS = 5_000;

class HttpIndexerClient implements IndexerPort {
  isIndexed(chainId: number): boolean {
    // Envio indexes the one chain this build is configured for; other
    // chains have no deployment to index.
    return indexerUrl() !== null && chainId === getActiveChain().id;
  }

  async getUserEvents(
    address: string,
    query: IndexedEventsQuery = {},
  ): Promise<readonly IndexedEvent[] | null> {
    const url = indexerUrl();
    if (!url) return null;
    const params = new URLSearchParams({ address: address.toLowerCase() });
    if (query.fromBlock != null) params.set("fromBlock", String(query.fromBlock));
    if (query.events?.length) params.set("events", query.events.join(","));
    if (query.limit != null) params.set("limit", String(query.limit));
    if (query.cursor) params.set("cursor", query.cursor);
    try {
      const res = await fetch(`${url}/user-events?${params.toString()}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { events?: unknown };
      if (!Array.isArray(body.events)) return null;
      return body.events as IndexedEvent[];
    } catch {
      // Unreachable, slow, or malformed — "not indexed yet", never an error.
      return null;
    }
  }
}

/** The session-wide client. One indexer, one client. */
let singleton: IndexerPort | null = null;

export function getIndexerClient(): IndexerPort {
  singleton ??= new HttpIndexerClient();
  return singleton;
}

/** Test seam: drop the singleton so a suite starts clean. */
export function disposeIndexerClient(): void {
  singleton = null;
}
