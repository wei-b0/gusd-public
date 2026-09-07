/**
 * Shared event metadata. Handlers stay thin: every history row starts from
 * eventKeys(event, context.chain.id) — the (chainId, blockNumber, logIndex)
 * primary key plus the chain-time settlement timestamp. No wall-clock values
 * are ever read here; these are pure extractions of chain-provided fields.
 */
interface EventMeta {
  block: { number: bigint; timestamp: bigint };
  log: { logIndex: number };
  transaction: { hash: `0x${string}` };
}

export interface EventKeys {
  chainId: number;
  blockNumber: number;
  logIndex: number;
  blockTimestamp: number;
}

export function eventKeys(event: EventMeta, chainId: number): EventKeys {
  return {
    chainId,
    blockNumber: Number(event.block.number),
    logIndex: event.log.logIndex,
    blockTimestamp: Number(event.block.timestamp),
  };
}

/** Transaction hash of the log the event came from — the correlation key the
 *  wire contract carries alongside the (blockNumber, logIndex) position. */
export function eventTxHash(event: EventMeta): `0x${string}` {
  return event.transaction.hash;
}

/**
 * JSON-safe codec for decoded event args: bigint → decimal string (JSON has
 * no bigint), hex strings lowercased (addresses, pool/gpu ids, hashes), and
 * recursion through arrays and plain objects. Numbers (small uints decode as
 * numbers in viem) and strings pass through; null/undefined/booleans pass
 * through untouched. Deterministic by construction — no wall clock, no RNG.
 */
export function eventToData(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    // Case-insensitive prefix: "0X..." is still hex and must normalize.
    return /^0x/i.test(value) ? value.toLowerCase() : value;
  }
  if (Array.isArray(value)) return value.map(eventToData);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, eventToData(v)]),
    );
  }
  return value;
}
