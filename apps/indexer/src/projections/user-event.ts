/**
 * The user_events projection — pure logic, no DB, no wall clock (rev 2
 * determinism). Membership is the CLOSED SET the web wire contract names
 * (apps/web/src/domain/indexer.ts INDEXED_EVENT_NAMES); the user resolution
 * table below is the single source of truth for who an event concerns:
 *
 *   Minted → `to` · Redeemed → `from` · Issued → `to`
 *   Buy / Sell → `recipient` · Deposit / Withdraw → `owner`
 *
 * `data` is the full decoded arg object through eventToData (bigint →
 * string, hex lowercased). Only chain-derived fields are produced here —
 * `seenAtMs` is mapped at the API boundary from blockTimestamp, never
 * stored.
 */
import type { Address, Hash } from "viem";
import { eventToData, type EventKeys } from "../events.js";

/** The closed set of user-facing events the wire contract draws from. */
export const INDEXED_EVENT_NAMES = [
  "Minted",
  "Redeemed",
  "Issued",
  "Buy",
  "Sell",
  "Deposit",
  "Withdraw",
] as const;

export type IndexedEventName = (typeof INDEXED_EVENT_NAMES)[number];

export interface UserEventInput {
  keys: EventKeys;
  /** Emitting contract address (event.log.address). */
  contract: Address;
  event: IndexedEventName;
  /** The user the event concerns, per the resolution table above. */
  user: Address;
  /** Full decoded args — the wire contract's `data`. */
  args: Record<string, unknown>;
  /** Transaction hash (event.transaction.hash). */
  txHash: Hash;
}

/** The user_events insert shape: PK + chain time + evidence fields. */
export interface UserEventRow {
  chainId: number;
  blockNumber: number;
  logIndex: number;
  blockTimestamp: number;
  contract: Address;
  event: IndexedEventName;
  user: Address;
  txHash: Hash;
  data: Record<string, unknown>;
}

/** True when the name is in the closed set — the loud gate handlers call
 *  behind their projection write. */
export function isIndexedEventName(name: string): name is IndexedEventName {
  return (INDEXED_EVENT_NAMES as readonly string[]).includes(name);
}

/** Build the user_events row: pure, deterministic, addresses lowercased. */
export function projectUserEvent(input: UserEventInput): UserEventRow {
  if (!isIndexedEventName(input.event)) {
    throw new Error(
      `"${input.event}" is not in the indexed user-event set (${INDEXED_EVENT_NAMES.join(", ")})`,
    );
  }
  return {
    ...input.keys,
    contract: input.contract.toLowerCase() as Address,
    event: input.event,
    user: input.user.toLowerCase() as Address,
    txHash: input.txHash.toLowerCase() as Hash,
    data: eventToData(input.args) as Record<string, unknown>,
  };
}
