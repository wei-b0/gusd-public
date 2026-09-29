"use client";

/**
 * PerpMarketsTable — the perpetuals board. The four settlement panels as
 * leveraged, gUSD-settled markets: mark, 24h, funding/day per side, open
 * interest, and the leverage cap — one ruled board for scanning; a row
 * routes to the market's perp desk. The mark is the benchmark (the engine
 * fills at oracle reports), so it prints in wire cyan with the / GPU-hour
 * unit, exactly as the spot board's Index column does; onchain market
 * figures print "—" until the chain asserts them (and in the mock
 * universe, where no perp markets exist).
 */

import Link from "next/link";
import { marketMove24h, pairName, type Market } from "@/domain/types";
import type { PerpMarketState } from "@/domain/types";
import { fmtGusdCompact, fmtPctSigned, fmtUsdPrecise, isFlatPct } from "@/domain/format";
import { TickFlash } from "@/components/ui/tick-flash";
import { useMarkets } from "@/data/services";
import { usePerpMarketStates } from "@/data/web3/perps/use-perp-markets";

/** Funding ppm/second → the per-day figure the desk speaks. */
function perDay(ppm: number): string {
  const pct = (ppm * 86_400) / 10_000;
  return `${pct.toFixed(3).replace(/\.?0+$/, "")}%`;
}

export function PerpMarketsTable() {
  const markets = useMarkets();
  const states = usePerpMarketStates();

  return (
    <div className="relative">
      <div className="overflow-x-auto">
        <table className="w-full table-auto border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-rule text-left">
              <th scope="col" className="slug py-2 pl-3 pr-4 text-dim">Market</th>
              <th scope="col" className="slug px-2.5 py-2 text-right text-dim">
                Mark <span className="tracking-normal normal-case">/ GPU-hour</span>
              </th>
              <th scope="col" className="slug px-2.5 py-2 text-right text-dim">24h</th>
              <th scope="col" className="slug px-2.5 py-2 text-right text-dim">
                Funding %/day <span className="tracking-normal normal-case">long · short</span>
              </th>
              <th scope="col" className="slug px-2.5 py-2 text-right text-dim">
                Open interest <span className="tracking-normal normal-case">/ gUSD</span>
              </th>
              <th scope="col" className="slug py-2 pl-2.5 pr-3 text-right text-dim">Lev cap</th>
            </tr>
          </thead>
          <tbody>
            {markets.map((m) => {
              const state = states[m.asset.id];
              return (
                <PerpMarketRow
                  key={m.asset.id}
                  market={m}
                  state={state === undefined ? undefined : (state ?? null)}
                />
              );
            })}
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

function PerpMarketRow({
  market: m,
  state,
}: {
  market: Market;
  state: PerpMarketState | null | undefined;
}) {
  const mark = m.marketPrice ?? m.indexPrice;
  const move = marketMove24h(m);
  const flat = move === null || isFlatPct(move);
  return (
    <tr className="group border-b border-rule transition-colors last:border-b-0 hover:bg-panel-deep">
      <td className="py-2 pl-3 pr-4">
        <Link href={`/perps/${m.asset.id}`} className="block outline-none">
          <span className="num block whitespace-nowrap text-[14px] font-bold leading-tight text-data transition-colors group-hover:text-bright">
            {pairName(m.asset.id)} <span className="text-[10.5px] font-normal text-dim">PERP</span>
          </span>
          <span className="mt-0.5 block whitespace-nowrap text-[10.5px] leading-tight text-dim">
            {m.asset.referenceSku}
          </span>
        </Link>
      </td>
      <td className="px-2.5 py-2 text-right">
        {mark === null || mark === undefined ? (
          <span className="num inline-block text-[13.5px] text-dim">—</span>
        ) : (
          <TickFlash value={mark} precision={4} arrow="pop" className="num inline-block text-[13.5px] font-bold text-wire">
            {fmtUsdPrecise(mark)}
          </TickFlash>
        )}
      </td>
      <td
        className={`num px-2.5 py-2 text-right ${flat ? "text-dim" : (move ?? 0) >= 0 ? "text-up" : "text-down"}`}
      >
        {move === null ? (
          "—"
        ) : (
          <span className="inline-flex items-baseline gap-1">
            <TickFlash value={move} precision={2} className="inline-block">
              {fmtPctSigned(move)}
            </TickFlash>
            {flat ? null : (
              <span aria-hidden className="text-[9px]">{move >= 0 ? "▲" : "▼"}</span>
            )}
          </span>
        )}
      </td>
      <td className="num px-2.5 py-2 text-right text-data">
        {state == null ? "—" : `${perDay(state.fundingRateLongPpmPerSec)} · ${perDay(state.fundingRateShortPpmPerSec)}`}
      </td>
      <td className="num px-2.5 py-2 text-right text-data">
        {state == null ? (
          "—"
        ) : (
          `${fmtGusdCompact(state.openInterestLong + state.openInterestShort)}`
        )}
      </td>
      <td className="num py-2 pl-2.5 pr-3 text-right text-data">
        {state == null ? "—" : `${state.maxLeverageBps / 10_000}×`}
      </td>
    </tr>
  );
}