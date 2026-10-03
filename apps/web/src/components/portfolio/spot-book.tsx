"use client";

/**
 * Portfolio spot book — the wallet's GPU asset positions marked to the
 * displayed price (venue price when a market layer exists, else the API's
 * Index — never a simulated stand-in), with Trade and Sell controls. The
 * marking math moved verbatim from the portfolio page.
 */

import Link from "next/link";
import { pairName, type Market, type Position } from "@/domain/types";
import {
  fmtGusd,
  fmtGusdPrecise,
  fmtNotional,
  fmtPctSigned,
  fmtUnits,
  isFlatPct,
} from "@/domain/format";
import { TuiPanel } from "@/components/ui/panel";

/** One marked spot row: the position plus its display figures. */
export interface SpotRow {
  p: Position;
  last: number | null;
  unit: string;
  value: number | null;
  pnl: number | null;
  pnlPct: number | null;
  flat: boolean;
}

/** Mark the wallet's spot positions to the displayed price. The unit
 *  follows the leg: gUSD per asset unit, or $ per GPU-hour while the
 *  benchmark is the market's price. The headline sums what can be marked;
 *  unmarkable positions print "—" in their row rather than a fabricated
 *  0 in the total. */
export function spotRows(
  positions: readonly Position[],
  markets: readonly Market[],
): { rows: SpotRow[]; positionsValue: number } {
  const priceOf = new Map(markets.map((m) => [m.asset.id, m.marketPrice ?? m.indexPrice]));
  const unitOf = new Map(markets.map((m) => [m.asset.id, m.marketPrice !== null ? "gUSD" : "/ GPU-hour"]));
  const rows: SpotRow[] = positions.map((p) => {
    // No cost-basis source pre-indexer: avgEntry is null then, and the P&L
    // columns print "—" rather than math against an invented basis. With
    // neither a market price nor a basis, the value itself is unmarkable.
    const last = priceOf.get(p.asset) ?? p.avgEntry;
    const unit = unitOf.get(p.asset) ?? "gUSD";
    const basis = p.avgEntry;
    const value = last === null ? null : p.size * last;
    const cost = basis === null ? null : p.size * basis;
    const pnl = value === null || cost === null ? null : value - cost;
    const pnlPct = last === null || basis === null ? null : (last / basis - 1) * 100;
    return { p, last, unit, value, pnl, pnlPct, flat: pnlPct === null || isFlatPct(pnlPct) };
  });
  const positionsValue = rows.reduce((sum, r) => sum + (r.value ?? 0), 0);
  return { rows, positionsValue };
}

/** 01 — the spot book, full width: identity, marking, and controls. The
 *  control links navigate (no .rev-d fill on a link — the Sell field fires
 *  inside the desk's OrderSlip once it lands). */
export function SpotBook({ rows, no }: {
  rows: readonly SpotRow[];
  no: string;
}) {
  return (
    <TuiPanel no={no} title="Market positions" meta={`${rows.length} markets`}>
      {rows.length === 0 ? (
        <p className="p-3.5 text-[11.5px] leading-relaxed text-dim">
          No market positions yet. Orders on{" "}
          <Link href="/" className="text-data underline decoration-rule-strong underline-offset-2 hover:text-bright">
            Markets
          </Link>{" "}
          or the{" "}
          <Link href="/spot" className="text-data underline decoration-rule-strong underline-offset-2 hover:text-bright">
            Terminal
          </Link>{" "}
          print here.
        </p>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-rule text-left">
                <th scope="col" className="sticky left-0 z-10 bg-panel slug py-2 pl-3.5 pr-4 text-dim">Market</th>
                <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Size</th>
                <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Avg entry</th>
                <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Last price</th>
                <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Value</th>
                <th scope="col" className="slug px-2.5 py-2 text-right text-dim">
                  P&amp;L <span className="tracking-normal normal-case">/ gUSD</span>
                </th>
                <th scope="col" className="slug py-2 pl-2.5 pr-3.5 text-right text-dim"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, last, unit, value, pnl, pnlPct, flat }) => (
                <tr key={p.asset} className="border-b border-rule last:border-b-0">
                  <td className="sticky left-0 z-10 bg-panel py-2.5 pl-3.5 pr-4">
                    <Link
                      href={`/spot/${p.asset}`}
                      className="num text-[13px] font-bold text-data transition-colors hover:text-bright"
                    >
                      {pairName(p.asset)}
                    </Link>
                  </td>
                  <td className="num px-2.5 py-2.5 text-right text-data">{fmtUnits(p.size)}</td>
                  <td className="num px-2.5 py-2.5 text-right text-data">
                    {p.avgEntry === null ? (
                      <span title={p.basisReason ?? undefined}>—</span>
                    ) : (
                      fmtGusdPrecise(p.avgEntry)
                    )}
                    <span className="ml-1 text-[10px] text-dim">{unit}</span>
                  </td>
                  <td className="num px-2.5 py-2.5 text-right text-data">
                    {last === null ? "—" : fmtGusdPrecise(last)}
                    <span className="ml-1 text-[10px] text-dim">{unit}</span>
                  </td>
                  <td className="num px-2.5 py-2.5 text-right font-bold text-bright">
                    {value === null ? "—" : fmtGusd(value)}
                  </td>
                  <td className="num py-2.5 pr-3.5 text-right whitespace-nowrap">
                    {pnl === null || pnlPct === null ? "—" : `${fmtNotional(Math.abs(pnl))} · ${fmtPctSigned(pnlPct)}`}
                    {!flat && pnl !== null && (
                      <span aria-hidden className="ml-1 text-[8px]">
                        {pnl >= 0 ? "▲" : "▼"}
                      </span>
                    )}
                    {p.realizedPnl !== null && (
                      <span className="block text-[10px] font-normal text-dim">
                        realized {p.realizedPnl < 0 ? "−" : "+"}{fmtNotional(Math.abs(p.realizedPnl))}
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 pl-2.5 pr-3.5 text-right whitespace-nowrap">
                    <Link
                      href={`/spot/${p.asset}`}
                      className="slug border border-rule-strong px-1.5 py-0.5 text-[8.5px] text-dim transition-colors hover:text-amber"
                    >
                      Trade
                    </Link>
                    <Link
                      href={`/spot/${p.asset}?side=sell`}
                      className="slug border border-rule-strong px-1.5 py-0.5 text-[8.5px] text-dim transition-colors hover:text-amber"
                    >
                      Sell
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-panel" />
          <p className="px-3.5 pb-3.5 pt-2.5 text-[10.5px] leading-relaxed text-dim">
            Marked to the displayed price — the venue's last trade when one exists, else the Index.
            Avg entry rides the indexer's protocol-attributable basis; unmarkable figures print "—".
          </p>
          <p className="px-3.5 pb-3.5 text-[10.5px] leading-relaxed text-dim">
            Sell routes to the desk with the slip already on the sell side; Trade opens it on buy.
          </p>
        </div>
      )}
    </TuiPanel>
  );
}
