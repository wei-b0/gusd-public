/**
 * The perp book's pure layer — probe aggregation shared by the portfolio
 * and the desk. Probes arrive as the port's tagged union; what the UI
 * shows (which rows are live, whether the book can be marked, what the
 * headline includes) is decided here so both surfaces answer identically.
 *
 * The honest-machine rules this module encodes:
 *   - `unknown` never erases a known row (a dropped poll is a gap, not a
 *     flat read) and an `unmarked` read keeps the last mark's timestamp.
 *   - A live row that can't be marked omits its equity from the headline
 *     and is named (`Perps —`), never a silent zero or an invented figure.
 */

import { ORACLE_PANELS } from "@/data/oracle/panel-map";
import type { PerpPositionProbe, PerpPositionState, PerpSide } from "@/domain/types";

/** Both sides of one market's book, as the port probed them. */
export interface PerpProbeSides {
  long: PerpPositionProbe;
  short: PerpPositionProbe;
}

/** Every market the engine registers, keyed by asset — the portfolio probes
 *  exactly this set (the four settlement SKUs; every AssetId is oracle-backed). */
export type PerpProbeMap = Record<keyof typeof ORACLE_PANELS, PerpProbeSides>;

/** All-unknown initial state — nothing read yet, never a fabricated flat. */
export function emptyProbes(): PerpProbeMap {
  const out = {} as PerpProbeMap;
  for (const asset of Object.keys(ORACLE_PANELS) as (keyof PerpProbeMap)[]) {
    out[asset] = {
      long: { kind: "unknown" },
      short: { kind: "unknown" },
    };
  }
  return out;
}

/** A probe's position — raw or marked; null only for flat/unknown. */
export function positionOf(probe: PerpPositionProbe): PerpPositionState | null {
  return probe.kind === "ok" || probe.kind === "unmarked" ? probe.position : null;
}

/** An unmarked read keeps the last mark's timestamp, so the footnote's
 *  "last verified Xs ago" stays truthful across a report gap instead of
 *  resetting to "no verified price yet" on every probe cycle. */
export function carryMark(next: PerpPositionProbe, prev: PerpPositionProbe): PerpPositionProbe {
  if (next.kind !== "unmarked") return next;
  const prevMarkedAt =
    prev.kind === "ok" || prev.kind === "unmarked" ? prev.position.markedAt : null;
  return { kind: "unmarked", position: { ...next.position, markedAt: prevMarkedAt } };
}

/** One cycle's probe folded onto the previous state: an `unknown` read
 *  returns the previous probe wholesale (a dropped poll never blanks a
 *  live row); anything else carries the mark timestamp. */
export function mergeProbe(next: PerpPositionProbe, prev: PerpPositionProbe): PerpPositionProbe {
  return next.kind === "unknown" ? prev : carryMark(next, prev);
}

/** One live row of the book. */
export interface PerpBookRow {
  asset: keyof typeof ORACLE_PANELS;
  side: PerpSide;
  position: PerpPositionState;
}

/** Live rows in display order: the panels' asset order, long before short —
 *  deterministic regardless of which probe resolved first. */
export function liveRows(probes: PerpProbeMap): PerpBookRow[] {
  const out: PerpBookRow[] = [];
  for (const asset of Object.keys(ORACLE_PANELS) as (keyof PerpProbeMap)[]) {
    for (const side of ["long", "short"] as const) {
      const position = positionOf(probes[asset][side]);
      if (position !== null) out.push({ asset, side, position });
    }
  }
  return out;
}

/** True while at least one market's existence is unresolved — the book
 *  shows its "reading" voice until every probe answered, never "flat". */
export function anyUnknown(probes: PerpProbeMap): boolean {
  return Object.values(probes).some(
    ({ long, short }) => long.kind === "unknown" || short.kind === "unknown",
  );
}

/** Every live row carries a verified mark — the precondition for the
 *  headline to include perp equity. */
export function allLiveMarked(rows: readonly PerpBookRow[]): boolean {
  return rows.length > 0 && rows.every((r) => r.position.markPrice !== null);
}

/** The claim gate's truth, from the probes: null while any market's
 *  existence is unresolved (claim never fires off an unreadable book),
 *  else whether any position is open. Wallet-global — one open position
 *  anywhere holds the claimable balance. */
export function openFromProbes(probes: PerpProbeMap): boolean | null {
  if (anyUnknown(probes)) return null;
  return liveRows(probes).length > 0;
}

/** The book's summed equity, or null while any live row is unmarked.
 *  Negative equities sum in — the debt is real and the wallet can't see it
 *  anywhere else. */
export function perpEquitySum(rows: readonly PerpBookRow[]): number | null {
  if (!allLiveMarked(rows)) return null;
  return rows.reduce((sum, r) => sum + (r.position.equity ?? 0), 0);
}

export interface PortfolioEquityInput {
  gUsd: number;
  sGUsdValue: number;
  spotValue: number;
  perpRows: readonly PerpBookRow[];
}

/**
 * The headline figure and its honesty flag. Perp equity counts toward the
 * total only when the book is fully known: no live rows (a verified flat
 * contributes zero) or every live row marked. With live-but-unmarked rows
 * the total omits perps entirely and the breakdown prints `Perps —` — the
 * gap is named by `perpCountsTowardTotal: false`, never a silent zero and
 * never a figure against an unverified price.
 */
export function portfolioEquity(input: PortfolioEquityInput): {
  total: number;
  perpEquity: number | null;
  perpCountsTowardTotal: boolean;
} {
  const base = input.gUsd + input.sGUsdValue + input.spotValue;
  if (input.perpRows.length === 0) {
    return { total: base, perpEquity: 0, perpCountsTowardTotal: true };
  }
  const perpEquity = perpEquitySum(input.perpRows);
  if (perpEquity === null) {
    return { total: base, perpEquity: null, perpCountsTowardTotal: false };
  }
  return { total: base + perpEquity, perpEquity, perpCountsTowardTotal: true };
}