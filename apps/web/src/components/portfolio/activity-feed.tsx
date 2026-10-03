"use client";

/**
 * Portfolio activity — the indexed ledger merged with this session's
 * in-flight / not-yet-indexed actions, newest first. Moved verbatim from
 * the portfolio page; the page still owns the merge inputs (indexed rows
 * vs. session cards) and hands them in as props.
 */

import { fmtClock, fmtGusdPrecise, fmtUnits } from "@/domain/format";
import type { ActionRecord } from "@/domain/actions";
import { PhaseTag } from "@/components/ui/action-status";
import { TuiPanel } from "@/components/ui/panel";
import type { ActivityRow } from "@/data/protocol/map";

type FeedEntry =
  | { kind: "indexed"; key: string; t: number; row: ActivityRow }
  | { kind: "session"; key: string; t: number; record: ActionRecord };

/** One merged feed: indexed ledger rows interleaved with the session's
 *  in-flight / not-yet-indexed action cards, newest first. */
function mergeFeed(rows: readonly ActivityRow[], cards: readonly ActionRecord[]): FeedEntry[] {
  const entries: FeedEntry[] = [
    ...rows.map((row): FeedEntry => ({ kind: "indexed", key: row.id, t: row.t, row })),
    ...cards.map((record): FeedEntry => ({
      kind: "session",
      key: record.id,
      t: record.createdAt,
      record,
    })),
  ];
  return entries.sort((a, b) => b.t - a.t);
}

/** The row's product label: "Buy 2.000 H100", or the verb with its gUSD
 *  figure when the event carries no GPU side ("Mint 10.0000 gUSD"). */
function rowLabel(r: ActivityRow): string {
  if (r.size !== null && r.asset !== null) return `${r.verb} ${fmtUnits(r.size)} ${r.asset}`;
  if (r.notional !== null) return `${r.verb} ${fmtGusdPrecise(r.notional)} gUSD`;
  return r.verb;
}

export function ActivityPanel({ indexedRows, sessionCards, hasEarlier, loadEarlier, no }: {
  indexedRows: readonly ActivityRow[];
  sessionCards: readonly ActionRecord[];
  hasEarlier: boolean;
  loadEarlier: () => void;
  no: string;
}) {
  const hasIndexed = indexedRows.length > 0;
  return (
    <TuiPanel
      no={no}
      title="Activity"
      meta={
        hasIndexed
          ? `${indexedRows.length + sessionCards.length} entries · newest first`
          : `${sessionCards.length} actions · this session · newest first`
      }
    >
      {indexedRows.length === 0 && sessionCards.length === 0 ? (
        <p className="p-3.5 text-[11.5px] leading-relaxed text-dim">
          Nothing has cleared yet. Orders, mints, and stakes print here as they settle.
        </p>
      ) : (
        <div className="border-t border-rule">
          {mergeFeed(indexedRows, sessionCards).map((entry) =>
            entry.kind === "indexed" ? (
              <IndexedRow key={entry.key} row={entry.row} />
            ) : (
              <SessionRow key={entry.key} record={entry.record} />
            ),
          )}
          {hasEarlier && (
            <div className="px-3.5 py-2.5">
              <button
                type="button"
                onClick={loadEarlier}
                className="slug border border-rule-strong px-2 py-1 text-[9px] text-dim transition-colors hover:text-amber"
              >
                Load earlier
              </button>
            </div>
          )}
        </div>
      )}
    </TuiPanel>
  );
}

function IndexedRow({ row }: { row: ActivityRow }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 border-b border-rule px-3.5 py-2 last:border-b-0">
      <span className="num w-20 shrink-0 whitespace-nowrap text-[11px] text-dim">
        {fmtClock(row.t)} <span className="text-[9px]">UTC</span>
      </span>
      <span className="num min-w-0 flex-1 truncate text-[12.5px] font-bold text-data">
        {rowLabel(row)}
      </span>
      <span className="slug border border-rule-strong px-1.5 py-0.5 text-[8.5px] text-dim">
        indexed
      </span>
    </div>
  );
}

function SessionRow({ record }: { record: ActionRecord }) {
  const hashes = record.steps.flatMap((s) => (s.hash !== null ? [s.hash.toLowerCase()] : []));
  const reflected =
    record.indexed !== null && hashes.some((h) => record.indexed!.includes(h));
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 border-b border-rule px-3.5 py-2 last:border-b-0">
      <span className="num w-20 shrink-0 whitespace-nowrap text-[11px] text-dim">
        {fmtClock(record.createdAt)} <span className="text-[9px]">UTC</span>
      </span>
      <span className="num min-w-0 flex-1 truncate text-[12.5px] font-bold text-data">
        {record.label}
      </span>
      {reflected && (
        <span className="slug border border-rule-strong px-1.5 py-0.5 text-[8.5px] text-dim">
          indexed
        </span>
      )}
      <PhaseTag phase={record.phase} />
    </div>
  );
}
