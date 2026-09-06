"use client";

/**
 * MarketsDiscovery — the front door and the Markets surface. Discovery,
 * scanning, comparison: what GPU markets exist, what they trade at, how
 * they moved, where the Index stands, and whether each market carries a
 * premium or discount. Execution lives on the Terminal — one roof for depth
 * and the trade ticket; this page deliberately has none.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { marketMove24h, pairName } from "@/domain/types";
import { useMarkets } from "@/data/services";
import { fmtGusdCompact, fmtGusdPrecise, fmtPctSigned, fmtUsdPrecise, isFlatPct } from "@/domain/format";
import { Gusd } from "@/components/ui/pair";
import { MarketsTable } from "@/components/markets/markets-table";
import { Sparkline } from "@/components/charts/sparkline";
import { TuiPanel } from "@/components/ui/panel";

export function MarketsDiscovery() {
  const markets = useMarkets();

  // Totals over possibly-absent market figures: a sum exists only when at
  // least one market has the figure — otherwise the cell prints "—".
  const totalOf = (vals: (number | null)[]): number | null => {
    const nums = vals.filter((v): v is number => v !== null);
    return nums.length === 0 ? null : nums.reduce((sum, n) => sum + n, 0);
  };
  const hasVenue = markets.some((m) => m.marketPrice !== null);
  const totalVolume = totalOf(markets.map((m) => m.volume24hUsd));
  const totalLiquidity = totalOf(markets.map((m) => m.liquidityUsd));
  const byMove = [...markets].sort(
    (a, b) => (marketMove24h(b) ?? -Infinity) - (marketMove24h(a) ?? -Infinity),
  );
  const leader = byMove[0];
  const laggard = byMove[byMove.length - 1];
  const leaderMove = leader ? marketMove24h(leader) : null;
  const laggardMove = laggard ? marketMove24h(laggard) : null;
  const basisList = markets
    .map((m) => m.basisPct)
    .filter((b): b is number => b !== null)
    .sort((a, b) => a - b);
  const medianBasis = basisList.length > 0 ? basisList[Math.floor(basisList.length / 2)]! : null;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-rule-strong pb-3">
        <h1 className="disp text-[22px] leading-none text-primary">Markets</h1>
        <p className="slug text-dim">
          GPU asset markets · priced in <Gusd />
        </p>
      </div>

      {/* 01 — the class in one ledger */}
      <TuiPanel no="01" title="Class overview" meta="trailing 24h">
        <dl className="grid grid-cols-2 gap-x-8 p-3.5 md:grid-cols-3 xl:grid-cols-5">
          <Cell
            label={<>Total 24h volume / <span className="normal-case">gUSD</span></>}
            value={totalVolume === null ? "—" : fmtGusdCompact(totalVolume)}
          />
          <Cell
            label={<>Total liquidity / <span className="normal-case">gUSD</span></>}
            value={totalLiquidity === null ? "—" : fmtGusdCompact(totalLiquidity)}
          />
          {leader && (
            <Cell
              label="Leader 24h"
              value={`${pairName(leader.asset.id)} ${leaderMove === null ? "—" : fmtPctSigned(leaderMove)}`}
              tone={leaderMove === null || isFlatPct(leaderMove) ? "dim" : "up"}
              dir={leaderMove === null || isFlatPct(leaderMove) ? undefined : leaderMove >= 0 ? "up" : "down"}
            />
          )}
          {laggard && (
            <Cell
              label="Laggard 24h"
              value={`${pairName(laggard.asset.id)} ${laggardMove === null ? "—" : fmtPctSigned(laggardMove)}`}
              tone={laggardMove === null || isFlatPct(laggardMove) ? "dim" : "down"}
              dir={laggardMove === null || isFlatPct(laggardMove) ? undefined : laggardMove >= 0 ? "up" : "down"}
            />
          )}
          <Cell
            label="Median premium"
            value={medianBasis === null ? "—" : fmtPctSigned(medianBasis)}
            tone={medianBasis === null ? "dim" : medianBasis >= 0 ? "amber" : "wire"}
          />
        </dl>
      </TuiPanel>

      {/* 02 — the discovery table */}
      <div className="mt-5">
        <TuiPanel no="02" title="GPU markets" meta={`${markets.length} markets`}>
          <MarketsTable markets={markets} />
        </TuiPanel>
      </div>

      {/* 03 — one card per market, equal weight */}
      <div className="mt-5">
        <TuiPanel no="03" title="48h charts" meta="every market · equal weight">
          <div className="grid gap-px bg-rule sm:grid-cols-2 xl:grid-cols-3">
            {markets.map((m) => {
              const move = marketMove24h(m);
              const flat = isFlatPct(move);
              const hasVenue = m.marketPrice !== null;
              return (
                <Link
                  key={m.asset.id}
                  href={`/terminal/${m.asset.id}`}
                  className="group bg-panel p-3 transition-colors hover:bg-panel-deep"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="num text-[14px] font-bold text-data transition-colors group-hover:text-bright">
                      {pairName(m.asset.id)}
                    </span>
                    <span
                      className={`num inline-flex items-baseline gap-1 text-[12px] ${
                        move === null || flat ? "text-dim" : move >= 0 ? "text-up" : "text-down"
                      }`}
                    >
                      {move === null || flat ? null : (
                        <span aria-hidden className="text-[9px]">
                          {move >= 0 ? "▲" : "▼"}
                        </span>
                      )}
                      {move === null ? "—" : fmtPctSigned(move)}
                    </span>
                  </div>
                  {/* One canonical price per card: the venue price when a
                      market layer exists, otherwise the benchmark itself. */}
                  {hasVenue ? (
                    <p className="num mt-1 text-[20px] font-bold leading-tight text-bright">
                      {fmtGusdPrecise(m.marketPrice!)}
                      <span className="ml-1.5 align-baseline text-[11px] font-normal text-dim">gUSD</span>
                    </p>
                  ) : m.indexPrice !== null ? (
                    <p className="num mt-1 text-[20px] font-bold leading-tight text-wire">
                      {fmtUsdPrecise(m.indexPrice)}
                      <span className="ml-1.5 align-baseline text-[11px] font-normal text-dim">/ GPU-hour</span>
                    </p>
                  ) : (
                    <p className="num mt-1 text-[20px] font-bold leading-tight text-dim">—</p>
                  )}
                  <Sparkline values={m.sparkline} className="mt-1.5 h-12 w-full" />
                  <p className="num mt-1.5 flex items-baseline justify-between text-[10px]">
                    {hasVenue ? (
                      <>
                        <span className="text-dim">
                          Index{" "}
                          <span className={m.indexPrice === null ? "text-dim" : "text-wire"}>
                            {m.indexPrice === null ? "—" : fmtUsdPrecise(m.indexPrice)}
                          </span>
                          <span className="text-dim"> / GPU-hour</span>
                        </span>
                        <span className={m.basisPct === null ? "text-dim" : m.basisPct >= 0 ? "text-amber" : "text-wire"}>
                          {m.basisPct === null ? "—" : fmtPctSigned(m.basisPct)}
                        </span>
                      </>
                    ) : (
                      <span className="text-dim">benchmark series · 48h</span>
                    )}
                  </p>
                </Link>
              );
            })}
            {/* Empty tracks at 2/3-column widths read as intentional void, not gap bleed */}
            <span aria-hidden className="hidden bg-ground sm:block" />
            <span aria-hidden className="hidden bg-ground xl:block" />
          </div>
        </TuiPanel>
      </div>

      <p className="mt-3 max-w-prose text-[11.5px] leading-relaxed text-dim">
        Price is the weighted benchmark for each GPU-hour, built from provider observations and
        bucketed by the oracle into the candles above. Before a venue goes live it is the one price
        a market has — where a market layer prices the asset separately, the gap prints as a
        premium or a discount; volume and liquidity wait for that layer.
      </p>
    </div>
  );
}

function Cell({
  label,
  value,
  tone = "data",
  dir,
}: {
  label: ReactNode;
  value: string;
  tone?: "data" | "up" | "down" | "amber" | "wire" | "dim";
  dir?: "up" | "down";
}) {
  const toneClass = {
    data: "text-data",
    up: "text-up",
    down: "text-down",
    amber: "text-amber",
    wire: "text-wire",
    dim: "text-dim",
  }[tone];
  return (
    <div className="border-b border-rule py-2">
      <dt className="slug text-dim">{label}</dt>
      <dd className={`num mt-1 text-[14px] font-bold ${toneClass}`}>
        {dir && (
          <span aria-hidden className="mr-1 text-[9px]">
            {dir === "up" ? "▲" : "▼"}
          </span>
        )}
        {value}
      </dd>
    </div>
  );
}
