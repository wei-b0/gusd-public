/**
 * The read path. One viem PublicClient per chain, memoized process-wide.
 *
 * Doctrine: the chain is never a display source for market data — prices,
 * OHLC, and history come from the API/oracle feed. This client exists for
 * execution support and correctness: transaction receipts, allowances,
 * simulation, and the interim balances/positions reads that validate and
 * reconcile actions until the Ponder indexer ships (see src/domain/indexer.ts).
 *
 * Transport is plain http with modest batching/timeouts, matching the
 * publisher's house style. Never imported unless a wallet session exists.
 */

import { createPublicClient, http, type PublicClient } from "viem";
import { getActiveChain } from "./chains";

const clients = new Map<number, PublicClient>();

/**
 * The memoized PublicClient for a chain id. Only the active chain is
 * readable today — a read against any other id has no honest transport to
 * use, so it refuses rather than silently querying the wrong network.
 */
export function getPublicClient(chainId?: number): PublicClient {
  const active = getActiveChain();
  if (chainId !== undefined && chainId !== active.id) {
    throw new Error(`No read client for chain ${chainId} — this desk trades on chain ${active.id}.`);
  }
  const existing = clients.get(active.id);
  if (existing) return existing;
  const client = createPublicClient({
    chain: active,
    transport: http(undefined, {
      batch: { wait: 16 },
      timeout: 10_000,
      retryCount: 2,
      retryDelay: 250,
    }),
  });
  clients.set(active.id, client);
  return client;
}

/** Drop a memoized client (tests, or an RPC override changing under us). */
export function disposePublicClient(chainId?: number): void {
  if (chainId === undefined) clients.clear();
  else clients.delete(chainId);
}
