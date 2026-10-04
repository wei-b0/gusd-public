"use client";

/**
 * Portfolio perp book — the wallet's gUSD-settled perpetual positions as
 * verified chain probes (`perp.getPosition` across every settlement panel,
 * both sides), not indexer projections re-marked by preview math. Rows
 * carry a one-click full close; the claimable counter reads the chain
 * first and the indexed projection only fills the gap while that read is
 * missing. The desk's PositionsBand/AccountPanel grammar is mirrored here
 * so a position row reads identically on both surfaces.
 */

import { useState } from "react";
import Link from "next/link";
import type { ActionRecord } from "@/domain/actions";
import type { PerpSide } from "@/domain/types";
import { pairName } from "@/domain/types";
import { fmtAge, fmtGusdLedger, fmtGusdPrecise, fmtSignedGusd } from "@/domain/format";
import { ActionStatus } from "@/components/ui/action-status";
import { TuiPanel } from "@/components/ui/panel";
import { useActiveAction, useServices } from "@/data/services";
import { num } from "@/components/perps/funding-voices";
import {
  liveRows,
  anyUnknown,
  openFromProbes,
  type PerpBookRow,
} from "@/data/web3/perps/portfolio-book";
import type { PerpPortfolioBook } from "@/data/web3/perps/use-perp-portfolio";

export function PerpBook({ book, no }: { book: PerpPortfolioBook; no: string }) {
  const { perp } = useServices();
  const closeActive = useActiveAction("perp-close") !== null;
  const claimActive = useActiveAction("perp-claim");
  const [closeSettled, setCloseSettled] = useState<ActionRecord | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [claimSettled, setClaimSettled] = useState<ActionRecord | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);

  const rows = liveRows(book.probes);
  const unknown = anyUnknown(book.probes);
  const reading = !book.loaded || unknown;
  const flat = book.connected && !reading && rows.length === 0;
  // The first live position carries the mark-age footnote.
  const first = rows[0]?.position ?? null;

  // The claim gate: claimable is wallet-global, so one open position
  // anywhere holds it — and an unreadable book (anyOpen null) blocks too:
  // claim never fires off an unreadable position state.
  const anyOpen = openFromProbes(book.probes);
  const claimBlocked = anyOpen !== false;
  const claimableReady = book.claimable !== null && book.claimable > 0;
  const canClaim = claimActive === null && claimableReady && !claimBlocked;

  async function marketClose(asset: PerpBookRow["asset"], side: PerpSide) {
    if (closeActive) return;
    setCloseError(null);
    try {
      const record = await perp.close({ asset, side, size: null });
      setCloseSettled(record);
      book.refresh();
    } catch (err) {
      setCloseError(
        err instanceof Error ? err.message : "The close didn't arm. Try again in a moment.",
      );
    }
  }

  async function claim() {
    if (claimActive !== null || book.claimable === null || book.claimable <= 0 || claimBlocked)
      return;
    const amount = book.claimable;
    setClaimError(null);
    try {
      const record = await perp.claim(amount);
      setClaimSettled(record);
      book.refresh();
    } catch (err) {
      setClaimError(
        err instanceof Error ? err.message : "The claim didn't go through. Try again in a moment.",
      );
    }
  }

  return (
    <TuiPanel
      no={no}
      title="Perp positions"
      meta={
        book.connected
          ? rows.length > 0
            ? `${rows.length} open`
            : reading
              ? "reading…"
              : "flat"
          : "not connected"
      }
    >
      {!book.connected ? (
        <p className="px-3.5 py-3 text-[11.5px] leading-relaxed text-dim">
          Connect a wallet to hold perp positions.
        </p>
      ) : (
        <>
          {rows.length > 0 && (
            <div className="relative">
              <div className="overflow-x-auto">
                <table className="w-full table-auto border-collapse text-[12px]">
                  <thead>
                    <tr className="border-b border-rule text-left">
                      <th scope="col" className="sticky left-0 z-10 bg-panel slug py-2 pl-3.5 pr-4 text-dim">
                        Market
                      </th>
                      <th scope="col" className="slug px-2.5 py-2 text-left text-dim">Side</th>
                      <th scope="col" className="slug px-2.5 py-2 text-right text-dim">
                        Notional <span className="tracking-normal normal-case">/ gUSD</span>
                      </th>
                      <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Collateral</th>
                      <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Entry</th>
                      <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Mark</th>
                      <th scope="col" className="slug px-2.5 py-2 text-right text-dim">uPnL</th>
                      <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Equity</th>
                      <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Est. liq</th>
                      <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Distance</th>
                      <th scope="col" className="slug py-2 pl-2.5 pr-3.5 text-right text-dim">
                        <span className="sr-only">Close</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <PositionRow
                        key={`${row.asset}-${row.side}`}
                        row={row}
                        closeActive={closeActive}
                        onClose={() => marketClose(row.asset, row.side)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Advertise the horizontal swipe where the table clips */}
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-[linear-gradient(to_left,var(--color-ground),transparent)] lg:hidden"
              />
            </div>
          )}
          {rows.length === 0 && reading && (
            <p className="px-3.5 py-3 text-[11.5px] leading-relaxed text-dim">
              Reading the book…
            </p>
          )}
          {flat && (
            <p className="px-3.5 py-3 text-[11.5px] leading-relaxed text-dim">
              Flat — no open perp positions. Arm an open from the{" "}
              <Link
                href="/perps"
                className="text-data underline decoration-rule-strong underline-offset-2 hover:text-bright"
              >
                perps desk ▸
              </Link>
            </p>
          )}
          {rows.map(
            (row) =>
              row.position.liquidatable === true && (
                <p
                  key={`${row.asset}-${row.side}-liq`}
                  className="mx-3.5 mt-3 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber"
                >
                  {row.side === "long" ? "Long" : "Short"} position at the liquidation threshold —
                  the next report past maintenance lets anyone liquidate. Close now; the position
                  does not recover on its own.
                </p>
              ),
          )}
          {rows.length > 0 && first && (
            <p className="px-3.5 pb-3.5 pt-2 slug text-[10px] text-dim">
              {first.markPrice !== null && first.markedAt !== null
                ? `Rows mark at the verified report price (${fmtAge(first.markedAt, Date.now())} old) — accrued funding settles at the next onchain touch.`
                : first.markedAt !== null
                  ? `Marking unavailable right now — rows show raw onchain figures; last verified ${fmtAge(first.markedAt, Date.now())}.`
                  : "Marking unavailable right now — rows show raw onchain figures until a verified price report prices them."}
            </p>
          )}
          <div className="border-t border-rule px-3.5 pb-3.5 pt-3">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="slug text-dim">Claimable</dt>
              <dd className="flex items-baseline gap-2">
                <span className="num text-[12px] text-bright">
                  {book.claimable === null ? "—" : fmtGusdLedger(book.claimable)}
                </span>
                <button
                  type="button"
                  onClick={claim}
                  disabled={!canClaim}
                  className="slug border border-rule-strong px-2.5 py-0.5 text-dim transition-colors hover:text-amber disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {claimActive !== null ? "Claiming…" : "Claim"}
                </button>
              </dd>
            </div>
            {claimableReady && claimBlocked ? (
              <p className="pt-1 text-[10.5px] leading-relaxed text-dim">
                {anyOpen === null
                  ? "Can't read your positions right now — the Claim button waits until the reads come back."
                  : "One or more perp positions are open — close them to free the claimable balance for payout."}
              </p>
            ) : null}
          </div>
          {closeSettled && (
            <div className="px-3.5 pb-3.5">
              <ActionStatus record={closeSettled} />
            </div>
          )}
          {claimSettled && (
            <div className="px-3.5 pb-3.5">
              <ActionStatus record={claimSettled} />
            </div>
          )}
          {closeError && (
            <p className="mx-3.5 mb-3.5 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
              {closeError}
            </p>
          )}
          {claimError && (
            <p className="mx-3.5 mb-3.5 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
              {claimError}
            </p>
          )}
        </>
      )}
    </TuiPanel>
  );
}

/** One live row — the desk's PositionRow grammar with a sticky identity
 *  column: the market links to its perps desk, the side wears the
 *  direction hue, and every figure is the probe's own (marked where a
 *  current report priced the read, raw with the marking voice where not). */
function PositionRow({
  row,
  closeActive,
  onClose,
}: {
  row: PerpBookRow;
  closeActive: boolean;
  onClose: () => void;
}) {
  const p = row.position;
  const long = row.side === "long";
  const liqDist =
    p.liquidationPrice !== null && p.markPrice !== null && p.markPrice > 0
      ? Math.abs((p.liquidationPrice - p.markPrice) / p.markPrice) * 100
      : null;
  const nearLiq = liqDist !== null && liqDist <= 10;
  // Negative equity is real debt — shown signed and down-toned, amber once
  // it sits under the maintenance floor.
  const underWater = p.equity !== null && p.maintenance !== null && p.equity < p.maintenance;
  return (
    <tr className="group border-b border-rule transition-colors last:border-b-0 hover:bg-panel-deep">
      <td className="sticky left-0 z-10 bg-panel py-2 pl-3.5 pr-4 transition-colors group-hover:bg-panel-deep">
        <Link
          href={`/perps/${row.asset}`}
          className="num text-[13px] font-bold text-data transition-colors hover:text-bright"
        >
          {pairName(row.asset)}
        </Link>
      </td>
      <td className={`slug px-2.5 py-2 ${long ? "text-up" : "text-down"}`}>
        <span aria-hidden className="mr-1 text-[8px]">{long ? "▲" : "▼"}</span>
        {long ? "LONG" : "SHORT"}
      </td>
      <td className="num px-2.5 py-2 text-right font-bold text-bright">{fmtGusdLedger(p.sizeUsd)}</td>
      <td className="num px-2.5 py-2 text-right text-data">{fmtGusdLedger(p.collateral)}</td>
      <td className="num px-2.5 py-2 text-right text-data">{fmtGusdPrecise(p.entryPrice)}</td>
      <td className="num px-2.5 py-2 text-right text-data">
        {p.markPrice === null ? "—" : fmtGusdPrecise(p.markPrice)}
      </td>
      <td
        className={`num px-2.5 py-2 text-right font-bold ${p.uPnl === null ? "text-dim" : p.uPnl >= 0 ? "text-up" : "text-down"}`}
      >
        {p.uPnl === null ? "—" : fmtSignedGusd(p.uPnl)}
      </td>
      <td
        className={`num px-2.5 py-2 text-right ${p.equity === null ? "text-dim" : underWater ? "text-amber" : p.equity < 0 ? "text-down" : "text-data"}`}
      >
        {p.equity === null ? "—" : fmtSignedGusd(p.equity)}
      </td>
      <td className="num px-2.5 py-2 text-right text-data">
        {p.liquidationPrice === null ? "—" : fmtGusdPrecise(p.liquidationPrice)}
      </td>
      <td className={`num px-2.5 py-2 text-right font-bold ${nearLiq ? "text-amber" : "text-data"}`}>
        {liqDist === null ? "—" : `${num(liqDist)}%`}
      </td>
      <td className="py-2 pl-2.5 pr-3.5 text-right">
        <button
          type="button"
          onClick={onClose}
          disabled={closeActive}
          className="slug border border-rule-strong px-2.5 py-0.5 text-dim transition-colors hover:text-bright disabled:cursor-not-allowed disabled:opacity-40"
        >
          {closeActive ? "closing…" : "Close"}
        </button>
      </td>
    </tr>
  );
}