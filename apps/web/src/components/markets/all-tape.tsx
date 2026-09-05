"use client";

/**
 * AllTape — every market's prints on one tape, newest first, each print
 * tagged with its market. The multi-market read: trade activity across all
 * GPU asset markets at a glance.
 */

import { useMemo, useRef, useSyncExternalStore } from "react";
import type { AssetId, MarketTrade } from "@/domain/types";
import { ASSET_IDS } from "@/domain/types";
import { useServices } from "@/data/services";
import { fmtClock, fmtGusdPrecise, fmtNotional, fmtUnits } from "@/domain/format";

const LIMIT = 18;

/** One tape print tagged with its market. */
interface TaggedTrade extends MarketTrade {
  asset: AssetId;
}

/** Merged, newest-first tape across every market; refreshed on live ticks. */
function useAllTape(): TaggedTrade[] {
  const { marketData } = useServices();
  const cache = useRef<{ live: TaggedTrade[] | null; server: TaggedTrade[] | null }>({
    live: null,
    server: null,
  });
  const merge = useMemo(
    () =>
      () =>
        ASSET_IDS.flatMap((id) =>
          marketData.getRecentTrades(id).map((trade) => ({ ...trade, asset: id })),
        )
          .sort((a, b) => b.t - a.t)
          .slice(0, LIMIT),
    [marketData],
  );
  const subscribe = useMemo(
    () => (listener: () => void) =>
      marketData.subscribe(() => {
        cache.current.live = merge();
        listener();
      }),
    [marketData, merge],
  );
  const getSnapshot = () => {
    if (!cache.current.live) cache.current.live = merge();
    return cache.current.live;
  };
  const getServerSnapshot = () => {
    if (!cache.current.server) cache.current.server = merge();
    return cache.current.server;
  };
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function AllTape() {
  const trades = useAllTape();
  return (
    <div>
      <div className="border-t border-rule">
        {trades.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11.5px] text-dim">
            No trades yet — the tape prints when the venues go live.
          </p>
        ) : (
          trades.map((trade) => <TapeRow key={trade.id} trade={trade} />)
        )}
      </div>
      <p className="num px-3 py-2.5 text-[10px] text-dim">
        {ASSET_IDS.length} GPU markets · priced in gUSD
      </p>
    </div>
  );
}

function TapeRow({ trade }: { trade: TaggedTrade }) {
  const buy = trade.side === "buy";
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-rule px-3 py-1.5">
      <span className="slug w-14 shrink-0 text-data">{trade.asset}</span>
      <span className="num hidden w-16 shrink-0 text-[11px] text-dim sm:inline">
        {fmtClock(trade.t)}
      </span>
      <span className={`slug w-16 shrink-0 ${buy ? "text-up" : "text-down"}`}>
        <span aria-hidden className="mr-1 text-[8px]">{buy ? "▲" : "▼"}</span>
        {buy ? "Bought" : "Sold"}
      </span>
      <span className="num flex-1 whitespace-nowrap text-right text-[12.5px] text-data">
        {fmtUnits(trade.size)} @ {fmtGusdPrecise(trade.price)}
      </span>
      <span className="num w-20 shrink-0 text-right text-[11.5px] text-dim">
        {fmtNotional(trade.notional)}
      </span>
    </div>
  );
}
