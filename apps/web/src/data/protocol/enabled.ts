/**
 * Feature gates for the indexed protocol surfaces. Kept apart from the
 * client so mock mode can stay provably network-free: no gate, no store,
 * no fetch.
 */

import { DATA_SOURCE } from "@/data/oracle/config";
import { protocolBaseUrl } from "./client";

/** Whether the indexer is configured at all — wallet-history and
 *  transparency surfaces key off this alone (mock auth may still index). */
export function protocolEnabled(): boolean {
  return protocolBaseUrl() !== null;
}

/** Whether the indexed market surfaces may consume the protocol store.
 *  Mock market mode never does: its injected data is the whole world. */
export function protocolMarketEnabled(): boolean {
  return protocolEnabled() && DATA_SOURCE === "oracle";
}
