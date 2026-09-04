"use client";

/**
 * MarketsDiscovery — the front door and the Markets surface. Discovery,
 * scanning, comparison: what GPU markets exist, what they trade at, how
 * they moved, where the Index stands, and whether each market carries a
 * premium or discount. Execution lives on the market pages and the
 * Terminal; this page deliberately has none.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { pairName } from "@/domain/types";
import { useMarkets } from "@/data/services";
import { fmtGusdCompact, fmtGusdPrecise, fmtPctSigned, fmtUsdPrecise, isFlatPct } from "@/domain/format";
import { Gusd } from "@/components/ui/pair";
import { MarketsTable } from "@/components/markets/markets-table";
import { Sparkline } from "@/components/charts/sparkline";
import { TuiPanel } from "@/components/ui/panel";

export function MarketsDiscovery() {
  const markets = useMarkets();

  const totalVolume = markets.reduce((sum, m) => sum + m.volume24hUsd, 0);
  const totalLiquidity = markets.reduce((sum, m) => sum + m.liquidityUsd, 0);
  const byMove = [...markets].sort((a, b) => b.change24hPct - a.change24hPct);
  const leader = byMove[0];
  const laggard = byMove[byMove.length - 1];
  const basisList = markets.map((m) => m.basisPct).sort((a, b) => a - b);
  const medianBasis = basisList[Math.floor(basisList.length / 2)] ?? 0;

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
            value={fmtGusdCompact(totalVolume)}
          />
          <Cell
            label={<>Total liquidity / <span className="normal-case">gUSD</span></>}
            value={fmtGusdCompact(totalLiquidity)}
          />
          {leader && (
            <Cell
              label="Leader 24h"
              value={`${pairName(leader.asset.id)} ${fmtPctSigned(leader.change24hPct)}`}
              tone={isFlatPct(leader.change24hPct) ? "dim" : "up"}
              dir={isFlatPct(leader.change24hPct) ? undefined : leader.change24hPct >= 0 ? "up" : "down"}
            />
          )}
          {laggard && (
            <Cell
              label="Laggard 24h"
              value={`${pairName(laggard.asset.id)} ${fmtPctSigned(laggard.change24hPct)}`}
              tone={isFlatPct(laggard.change24hPct) ? "dim" : laggard.change24hPct >= 0 ? "up" : "down"}
              dir={isFlatPct(laggard.change24hPct) ? undefined : laggard.change24hPct >= 0 ? "up" : "down"}
            />
          )}
          <Cell
            label="Median premium"
            value={fmtPctSigned(medianBasis)}
            tone={medianBasis >= 0 ? "amber" : "wire"}
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
              const flat = isFlatPct(m.change24hPct);
              return (
                <Link
                  key={m.asset.id}
                  href={`/markets/${m.asset.id}`}
                  className="group bg-panel p-3 transition-colors hover:bg-panel-deep"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="num text-[14px] font-bold text-data transition-colors group-hover:text-bright">
                      {pairName(m.asset.id)}
                    </span>
                    <span
                      className={`num inline-flex items-baseline gap-1 text-[12px] ${
                        flat ? "text-dim" : m.change24hPct >= 0 ? "text-up" : "text-down"
                      }`}
                    >
                      {flat ? null : (
                        <span aria-hidden className="text-[9px]">
                          {m.change24hPct >= 0 ? "▲" : "▼"}
                        </span>
                      )}
                      {fmtPctSigned(m.change24hPct)}
                    </span>
                  </div>
                  <p className="num mt-1 text-[20px] font-bold leading-tight text-bright">
                    {fmtGusdPrecise(m.marketPrice)}
                    <span className="ml-1.5 align-baseline text-[11px] font-normal text-dim">gUSD</span>
                  </p>
                  <Sparkline values={m.sparkline} className="mt-1.5 h-12 w-full" />
                  <p className="num mt-1.5 flex items-baseline justify-between text-[10px]">
                    <span className="text-dim">
                      Index <span className="text-wire">{fmtUsdPrecise(m.indexPrice)}</span>
                      <span className="text-dim"> / GPU-hour</span>
                    </span>
                    <span className={m.basisPct >= 0 ? "text-amber" : "text-wire"}>
                      {fmtPctSigned(m.basisPct)}
                    </span>
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
        Index Price is the weighted reference for each GPU-hour, built from provider
        observations — it is never the market price. The gap between the two prints as a
        premium or a discount.
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
