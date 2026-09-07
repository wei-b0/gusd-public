"use client";

/**
 * MarketsTable — the discovery table. Every GPU asset market as a pair on
 * one ruled board: its last-48h shape, one canonical price, 24h movement,
 * and — when a market layer prices the row independently of the benchmark —
 * the Index price and the premium or discount the gap forms. Built for
 * scanning and comparison; a row routes to the market's desk on the
 * Terminal.
 */

import Link from "next/link";
import { marketMove24h, pairName, type Market } from "@/domain/types";
import { fmtGusdCompact, fmtGusdPrecise, fmtPctSigned, fmtUsdPrecise, isFlatPct } from "@/domain/format";
import { TickFlash } from "@/components/ui/tick-flash";
import { Sparkline } from "@/components/charts/sparkline";

/**
 * Venue-flow figures (Volume / Liquidity). The Volume column carries real
 * 24h swap volume and Liquidity the in-range gUSD-side depth of the
 * canonical pool — both from the Ponder indexer via the market seam. Rows
 * with no indexed pool print "—" (mock mode never invents them).
 */
const SHOW_MARKET_FLOWS = true;

export function MarketsTable({ markets }: { markets: Market[] }) {
  // One price per row. Where a venue prices the row (mock universe) the table
  // shows both legs and the gap; where the benchmark is the market's price
  // (oracle mode) a second price column would print the same number twice,
  // so the Index/Premium columns exist only under a venue leg.
  const hasVenue = markets.some((m) => m.marketPrice !== null);
  return (
    <div className="relative">
      <div className="overflow-x-auto">
        <table className="w-full table-auto border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-rule text-left">
              <th scope="col" className="slug py-2 pl-3 pr-4 text-dim">Market</th>
              <th scope="col" className="slug px-2.5 py-2 text-right text-dim">
                Price <span className="tracking-normal normal-case">{hasVenue ? "/ gUSD" : "/ GPU-hour"}</span>
              </th>
              <th scope="col" className="slug px-2.5 py-2 text-right text-dim">24h</th>
              <th scope="col" className="slug px-2.5 py-2 text-left text-dim">Last 48h</th>
              {hasVenue && (
                <th scope="col" className="slug px-2.5 py-2 text-right text-dim">
                  Index price <span className="tracking-normal">/ GPU-hour</span>
                </th>
              )}
              {hasVenue && (
                <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Premium / Discount</th>
              )}
              {SHOW_MARKET_FLOWS && (
                <>
                  <th scope="col" className="slug px-2.5 py-2 text-right text-dim">
                    Volume <span className="tracking-normal normal-case">/ gUSD</span>
                  </th>
                  <th scope="col" className="slug py-2 pl-2.5 pr-3 text-right text-dim">
                    Liquidity <span className="tracking-normal normal-case">/ gUSD</span>
                  </th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {markets.map((m) => (
              <MarketRow key={m.asset.id} market={m} hasVenue={hasVenue} />
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
  );
}

/** Figure emphasis scales with the size of the move — never color alone. */
function moveScale(pct: number): { size: string; weight: string } {
  const abs = Math.abs(pct);
  if (abs >= 4) return { size: "text-[15px]", weight: "font-bold" };
  if (abs >= 2) return { size: "text-[13.5px]", weight: "font-medium" };
  return { size: "text-[12.5px]", weight: "font-normal" };
}

function MarketRow({ market: m, hasVenue }: { market: Market; hasVenue: boolean }) {
  const basis = m.basisPct;
  const premium = basis !== null && basis >= 0;
  const move = marketMove24h(m);
  const scale = move === null ? { size: "text-[12.5px]", weight: "font-normal" } : moveScale(move);
  const flat24 = isFlatPct(move);

  return (
    <tr className="group border-b border-rule transition-colors last:border-b-0 hover:bg-panel-deep">
      <td className="py-2 pl-3 pr-4">
        <Link href={`/terminal/${m.asset.id}`} className="block outline-none">
          <span className="num block whitespace-nowrap text-[14px] font-bold leading-tight text-data transition-colors group-hover:text-bright">
            {pairName(m.asset.id)}
          </span>
          <span className="mt-0.5 block whitespace-nowrap text-[10.5px] leading-tight text-dim">
            {m.asset.referenceSku}
          </span>
        </Link>
      </td>
      <td className="px-2.5 py-2 text-right">
        {m.marketPrice !== null ? (
          <TickFlash
            value={m.marketPrice}
            precision={4}
            arrow="pop"
            className="num inline-block text-[13.5px] font-bold text-bright"
          >
            {fmtGusdPrecise(m.marketPrice)}
          </TickFlash>
        ) : m.indexPrice !== null ? (
          <TickFlash value={m.indexPrice} precision={4} arrow="pop" className="num inline-block text-[13.5px] font-bold text-wire">
            {fmtUsdPrecise(m.indexPrice)}
          </TickFlash>
        ) : (
          <span className="num inline-block text-[13.5px] text-dim">—</span>
        )}
      </td>
      <td
        className={`num px-2.5 py-2 text-right ${
          move === null || flat24 ? "text-dim" : move >= 0 ? "text-up" : "text-down"
        }`}
      >
        <span className={`${scale.size} ${scale.weight} inline-flex items-baseline gap-1`}>
          {move === null ? (
            "—"
          ) : (
            /* The 24h figure flashes only when it itself moves — a fresh
               Index tick that leaves it unchanged prints silently. */
            <TickFlash value={move} precision={2} className="inline-block">
              {fmtPctSigned(move)}
            </TickFlash>
          )}
          {move === null || flat24 ? null : (
            <span aria-hidden className="text-[9px]">{move >= 0 ? "▲" : "▼"}</span>
          )}
        </span>
      </td>
      <td className="w-40 px-2.5 py-2 sm:w-56">
        {/* One 48h shape per row, every trace the same width and height —
            the comparison the column exists for, beside the 24h figure it
            puts in context. */}
        <Sparkline values={m.sparkline} stretch className="block h-8 w-full" />
      </td>
      {hasVenue && (
        <td className="px-2.5 py-2 text-right">
          <span className="inline-flex items-center justify-end gap-1.5">
            {m.indexPrice === null ? (
              <span className="num inline-block text-[13.5px] text-dim">—</span>
            ) : (
              <TickFlash
                value={m.indexPrice}
                precision={4}
                arrow="pop"
                className="num inline-block text-[13.5px] font-bold text-wire"
              >
                {fmtUsdPrecise(m.indexPrice)}
              </TickFlash>
            )}
          </span>
        </td>
      )}
      {hasVenue && (
        <td className={`num px-2.5 py-2 text-right font-bold ${basis === null ? "text-dim" : premium ? "text-amber" : "text-wire"}`}>
          {basis === null ? "—" : fmtPctSigned(basis)}
        </td>
      )}
      {SHOW_MARKET_FLOWS && (
        <>
          <td className="num px-2.5 py-2 text-right text-dim">
            {m.volume24hUsd === null ? "—" : fmtGusdCompact(m.volume24hUsd)}
          </td>
          <td className="num py-2 pl-2.5 pr-3 text-right text-dim">
            {m.liquidityUsd === null ? "—" : fmtGusdCompact(m.liquidityUsd)}
          </td>
        </>
      )}
    </tr>
  );
}
