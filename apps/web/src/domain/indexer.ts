/**
 * The indexer port — the placeholder seam for the Ponder indexer.
 *
 * Nothing stands behind it yet: the only implementation is the HTTP stub
 * in src/data/indexer/indexer-client.ts, which is inert unless
 * NEXT_PUBLIC_INDEXER_URL is configured. Until it ships, direct contract
 * reads in the account store are the interim user-state source and every
 * ledger keeps "this session" provenance.
 *
 * The wire contract Ponder must serve, and the events it must index —
 * positions, balances-at-block, cost basis, and history all derive from
 * these and nothing else:
 *
 *   GUSD.Minted / GUSD.Redeemed      — gUSD supply-side history
 *   GPUIssuance.Issued               — primary issuance legs
 *   GpuRouter.Buy / GpuRouter.Sell   — secondary fills (pool legs + fees)
 *   sgUSD.Deposit / sgUSD.Withdraw   — stake / unstake
 *
 * Each event must resolve to the user it concerns:
 *
 *   Minted / Redeemed   → `to` (the minter / the redeemer)
 *   Issued              → `to`
 *   Buy                 → `recipient` (the payer is the same wallet here —
 *                         one user is one wallet)
 *   Sell                → `recipient`
 *   Deposit / Withdraw  → `owner`
 */

/** One indexed event, normalized by the indexer before it gets here. */
export interface IndexedEvent {
  /** The emitting contract, lowercase address. */
  contract: string;
  /** The event name exactly as declared above (e.g. "Buy"). */
  event: string;
  /** The user the event concerns, lowercase address. */
  user: string;
  /** The chain the event settled on. */
  chainId: number;
  blockNumber: number;
  logIndex: number;
  txHash: string;
  /** Wall-clock the indexer ingested the block — not chain time. */
  seenAtMs: number;
  /** Decoded args; numeric fields arrive as strings (JSON has no bigint). */
  data: Record<string, unknown>;
}

export interface IndexedEventsQuery {
  /** Only events at or after this block (inclusive). */
  fromBlock?: number;
  /** Only these event names; all indexed events when omitted. */
  events?: readonly string[];
  /** Page size hint. */
  limit?: number;
  /** Continuation token from a previous page. */
  cursor?: string;
}

export interface IndexerPort {
  /** Whether this chain has a live indexer behind it. */
  isIndexed(chainId: number): boolean;
  /**
   * The user's indexed events, newest first. Null means "no indexer, or it
   * hasn't caught up" — callers keep "this session" provenance. Never a
   * failure: indexing lag is not an error state and never renders as one.
   */
  getUserEvents(
    address: string,
    query?: IndexedEventsQuery,
  ): Promise<readonly IndexedEvent[] | null>;
}

/** The event names reconciliation draws evidence from — all of them. */
export const INDEXED_EVENT_NAMES = [
  "Minted",
  "Redeemed",
  "Issued",
  "Buy",
  "Sell",
  "Deposit",
  "Withdraw",
] as const;
