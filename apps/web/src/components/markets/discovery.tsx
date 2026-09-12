"use client";

/**
 * MarketsDiscovery — the front door and the Markets surface. Discovery,
 * scanning, comparison: what GPU markets exist, what they trade at, how
 * they moved, where the Index stands, and whether each market carries a
 * premium or discount. Execution lives on the Terminal — one roof for depth
 * and the trade ticket; this page deliberately has none.
 */

import type { ReactNode } from "react";
import { marketMove24h, pairName } from "@/domain/types";
import { useMarkets } from "@/data/services";
import { fmtGusdCompact, fmtPctSigned, isFlatPct } from "@/domain/format";
import { Gusd } from "@/components/ui/pair";
import { MarketsTable } from "@/components/markets/markets-table";
import { TuiPanel } from "@/components/ui/panel";

export function MarketsDiscovery() {
  const markets = useMarkets();

  // Totals over possibly-absent market figures: a sum exists only when at
  // least one market has the figure — otherwise the cell prints "—".
  const totalOf = (vals: (number | null)[]): number | null => {
    const nums = vals.filter((v): v is number => v !== null);
    return nums.length === 0 ? null : nums.reduce((sum, n) => sum + n, 0);
  };
  const totalVolume = totalOf(markets.map((m) => m.volume24hUsd));
  // Leader and laggard are the best and worst 24h movers. A market that
  // hasn't printed a 24h figure doesn't rank — an unprinted move is not a
  // performance — so nulls never outrank a real decline. (If nothing has
  // moved yet, the board's ends stand in.)
  const movers = markets.filter((m) => marketMove24h(m) !== null);
  const byMove = [...(movers.length > 0 ? movers : markets)].sort(
    (a, b) => (marketMove24h(b) ?? -Infinity) - (marketMove24h(a) ?? -Infinity),
  );
  const leader = byMove[0];
  const laggard = byMove[byMove.length - 1];
  const leaderMove = leader ? marketMove24h(leader) : null;
  const laggardMove = laggard ? marketMove24h(laggard) : null;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-rule-strong pb-3">
        <h1 className="disp text-[22px] leading-none text-primary">Markets</h1>
        <p className="slug text-dim">
          GPU asset markets · priced in <Gusd />
        </p>
      </div>

      {/* 01 — the class in one ledger: leader, laggard, and the class's
          total flow on one row (the flow drops full-width beneath them
          while the board is narrow) */}
      <TuiPanel no="01" title="Class overview" meta="trailing 24h">
        <dl className="grid grid-cols-2 gap-x-8 p-3 md:grid-cols-3">
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
            className="col-span-2 md:col-span-1"
            label={<>Total 24h volume / <span className="normal-case">gUSD</span></>}
            value={totalVolume === null ? "—" : fmtGusdCompact(totalVolume)}
          />
        </dl>
      </TuiPanel>

      {/* 02 — the discovery table: identity, the last-48h shape, and the
          figures on one ruled board — the whole class on one screen */}
      <div className="mt-5">
        <TuiPanel no="02" title="GPU markets" meta={`${markets.length} markets`}>
          <MarketsTable markets={markets} />
        </TuiPanel>
      </div>

      <p className="mt-3 max-w-prose text-[11.5px] leading-relaxed text-dim">
        Trade exposure to GPU compute rates across H100, H200, L40S, and RTX 4090. Prices are derived from live rental markets and settle onchain through gUSD.
      </p>
    </div>
  );
}

function Cell({
  label,
  value,
  tone = "data",
  dir,
  className,
}: {
  label: ReactNode;
  value: string;
  tone?: "data" | "up" | "down" | "amber" | "wire" | "dim";
  dir?: "up" | "down";
  className?: string;
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
    <div className={`border-b border-rule py-1.5 ${className ?? ""}`}>
      <dt className="slug text-dim">{label}</dt>
      <dd className={`num mt-1 text-[14px] font-bold ${toneClass}`}>
        {value}
        {dir && (
          <span aria-hidden className="ml-1 text-[9px]">
            {dir === "up" ? "▲" : "▼"}
          </span>
        )}
      </dd>
    </div>
  );
}
