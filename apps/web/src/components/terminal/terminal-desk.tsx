"use client";

/**
 * TerminalDesk — the professional desk: analyse and execute in one dense
 * composition. Deliberately denser and more capable than the market pages —
 * every market bound side-by-side, the chart, the trade ticket, the Index
 * feed, and the full tape. `/terminal` renders it on the top-volume market;
 * `/terminal/[asset]` opens it pre-bound. Desktop is spatial; mobile is
 * sequential tasks via the tab strip.
 */

import { useState, type ReactNode } from "react";
import Link from "next/link";
import type { AssetId, ChartRange } from "@/domain/types";
import { pairName } from "@/domain/types";
import {
  fmtGusd,
  fmtGusdCompact,
  fmtGusdPrecise,
  fmtPctSigned,
  fmtStamp,
  fmtUnits,
  fmtUsdPrecise,
  isFlatPct,
} from "@/domain/format";
import { useAccount, useMarketSnapshot, useMarkets } from "@/data/services";
import { PriceChart } from "@/components/charts/price-chart";
import { OrderSlip } from "@/components/markets/order-slip";
import { AllTape } from "@/components/markets/all-tape";
import { Gusd, Pair, SGusd } from "@/components/ui/pair";
import { TabBar } from "@/components/ui/tab-bar";
import { TickFlash } from "@/components/ui/tick-flash";
import { TuiPanel } from "@/components/ui/panel";

const RANGES = ["1D", "1W", "1M", "3M"] as const;
const TABS = ["Overview", "Chart", "Trade", "Index", "Activity"] as const;

export function TerminalDesk({ initial }: { initial: AssetId }) {
  const [asset, setAsset] = useState<AssetId>(initial);
  const [range, setRange] = useState<ChartRange>("1D");
  const [tab, setTab] = useState<string>("Overview");
  const markets = useMarkets();
  const snapshot = useMarketSnapshot(asset, range);
  const account = useAccount();

  if (!snapshot) return null;
  const m = snapshot.market;
  const premium = m.basisPct >= 0;
  const flat24 = isFlatPct(m.change24hPct);

  const vis = (name: string) => `${tab === name ? "" : "hidden"} lg:block`;
  // Grid items hide at the item level so hidden tracks create no rows or gaps.
  const cellVis = (names: string[]) =>
    (names.includes(tab) ? "" : "hidden") + " lg:block";

  return (
    <div>
      {/* Mobile task switcher — desktop stays spatial */}
      <div className="mb-5 lg:hidden">
        <TabBar tabs={TABS.map((id) => ({ id, label: id }))} active={tab} onChange={setTab} label="Terminal sections" />
      </div>

      <div className="grid gap-5 lg:grid-cols-[230px_minmax(0,1fr)_310px]">
        {/* Left rail — the markets, then the session's position here */}
        <div className={`order-4 space-y-5 lg:order-1 ${cellVis(["Overview"])}`}>
          <div>
            <TuiPanel no="01" title="Markets" meta={`${markets.length} markets`}>
              <div>
                {markets.map((mk) => {
                  const active = mk.asset.id === asset;
                  const flat = isFlatPct(mk.change24hPct);
                  return (
                    <button
                      key={mk.asset.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setAsset(mk.asset.id)}
                      className={`flex w-full items-baseline justify-between gap-2 border-b border-rule px-3 py-2 text-left transition-colors last:border-b-0 ${
                        active ? "bg-panel-deep" : "hover:bg-panel-deep"
                      }`}
                    >
                      <span className="flex items-baseline gap-1.5">
                        <span
                          aria-hidden
                          className={`text-[9px] ${active ? "text-amber" : "text-transparent"}`}
                        >
                          ▶
                        </span>
                        <span
                          className={`num text-[13px] font-bold whitespace-nowrap ${
                            active ? "text-bright" : "text-data"
                          }`}
                        >
                          {pairName(mk.asset.id)}
                        </span>
                      </span>
                      <span
                        className={`num inline-flex items-baseline gap-0.5 text-[11px] ${
                          flat ? "text-dim" : mk.change24hPct >= 0 ? "text-up" : "text-down"
                        }`}
                      >
                        {flat ? null : (
                          <span aria-hidden className="text-[8px]">
                            {mk.change24hPct >= 0 ? "▲" : "▼"}
                          </span>
                        )}
                        {fmtPctSigned(mk.change24hPct)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </TuiPanel>
          </div>

          <div>
            <PositionPanel asset={asset} account={account} />
          </div>
        </div>

        {/* Center — the plate */}
        <div className={`order-1 min-w-0 lg:order-2 ${cellVis(["Chart"])}`}>
          <div>
            <TuiPanel
              no="02"
              title={<Pair id={m.asset.id} />}
              meta="candles hourly · UTC"
              right={
                <div role="group" aria-label="Chart range" className="flex items-center">
                  {RANGES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      aria-pressed={range === r}
                      onClick={() => setRange(r)}
                      className={`num border-b px-2.5 py-1 text-[11px] transition-colors ${
                        range === r
                          ? "border-amber text-amber"
                          : "border-transparent text-dim hover:text-data"
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              }
            >
              <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2 border-b border-rule px-3.5 py-2.5">
                <span className="inline-flex items-baseline gap-1.5">
                  <TickFlash value={m.marketPrice} className="disp text-[26px] leading-none text-bright">
                    {fmtGusdPrecise(m.marketPrice)}
                  </TickFlash>
                  <span className="num text-[11px] text-dim">gUSD</span>
                </span>
                <span
                  className={`num inline-flex items-baseline gap-1 text-[12px] ${
                    flat24 ? "text-dim" : m.change24hPct >= 0 ? "text-up" : "text-down"
                  }`}
                >
                  {flat24 ? null : (
                    <span aria-hidden className="text-[9px]">
                      {m.change24hPct >= 0 ? "▲" : "▼"}
                    </span>
                  )}
                  {fmtPctSigned(m.change24hPct)} · 24h
                </span>
                <span className="inline-flex items-baseline gap-1.5">
                  <span className="slug text-dim">Index</span>
                  <TickFlash
                    value={m.indexPrice}
                    flash="wire"
                    className="num text-[14px] leading-none text-wire"
                  >
                    {fmtUsdPrecise(m.indexPrice)}
                  </TickFlash>
                </span>
                <span className={`num text-[12px] font-bold ${premium ? "text-amber" : "text-wire"}`}>
                  {premium ? "Premium" : "Discount"} {fmtPctSigned(m.basisPct)}
                </span>
                <span className="num text-[11.5px] text-dim">
                  Volume {fmtGusdCompact(m.volume24hUsd)} gUSD · Liquidity {fmtGusdCompact(m.liquidityUsd)} gUSD
                </span>
              </div>
              <div className="p-2 pr-3">
                <PriceChart
                  candles={snapshot.candles}
                  index={snapshot.index}
                  range={range}
                  livePrice={m.marketPrice}
                  className="h-96 lg:h-[56vh] lg:min-h-95"
                />
              </div>
              <div className="flex items-baseline justify-between border-t border-rule px-3.5 py-2">
                <p className="slug text-dim">Band shows the premium / discount gap</p>
                <Link
                  href={`/markets/${m.asset.id}`}
                  className="num text-[10px] text-dim transition-colors hover:text-amber"
                >
                  Market overview ▸
                </Link>
              </div>
            </TuiPanel>
          </div>
        </div>

        {/* Right rail — the trade, then the Index feed */}
        <div className={`order-2 space-y-5 lg:order-3 ${cellVis(["Trade", "Index"])}`}>
          <div className={vis("Trade")}>
            <TuiPanel no="03" title="Trade" meta="fee 6 bps">
              <OrderSlip assetId={m.asset.id} marketPrice={m.marketPrice} />
            </TuiPanel>
          </div>

          <div className={vis("Index")}>
            <TuiPanel
              title="Index feed"
              meta={`${snapshot.quality.sourcesLive}/${snapshot.quality.sourcesTotal} live`}
            >
              <div className="space-y-1.5 p-3.5">
                <div className="flex items-baseline justify-between border-b border-rule pb-2">
                  <span className="slug text-dim">
                    <Gusd /> {m.asset.id} Index
                  </span>
                  <TickFlash
                    value={m.indexPrice}
                    flash="wire"
                    className="num text-[16px] font-bold leading-none text-wire"
                  >
                    {fmtUsdPrecise(m.indexPrice)}
                  </TickFlash>
                </div>
                <Row label="Latency" value={`${snapshot.quality.latencyMs} ms`} tone="wire" />
                <Row label="Epoch" value={String(snapshot.quality.epoch)} tone="wire" />
                <Row label="Updated" value={fmtStamp(snapshot.quality.updatedAt)} tone="wire" />
                <p className="pt-1 text-[10.5px] leading-relaxed text-dim">
                  Source panel on{" "}
                  <Link
                    href={`/oracle/${m.asset.id}`}
                    className="text-data underline decoration-rule-strong underline-offset-2 hover:text-bright"
                  >
                    Index sources
                  </Link>
                  .
                </p>
              </div>
            </TuiPanel>
          </div>
        </div>
      </div>

      <div className={`mt-5 ${cellVis(["Activity"])}`}>
        <TuiPanel no="04" title="Recent trades" meta="all markets · newest first">
          <AllTape />
        </TuiPanel>
      </div>
    </div>
  );
}

function PositionPanel({ asset, account }: { asset: AssetId; account: ReturnType<typeof useAccount> }) {
  const position = account.positions.find((p) => p.asset === asset);
  return (
    <TuiPanel title="Position" meta={account.connected ? account.label ?? undefined : "not connected"}>
      {account.connected ? (
        <dl className="space-y-1.5 p-3.5">
          <Row label={<Pair id={asset} />} value={position ? `${fmtUnits(position.size)} units` : "—"} />
          <Row label="Avg entry" value={position ? fmtGusd(position.avgEntry) : "—"} />
          <Row label={<Gusd />} value={fmtGusdCompact(account.gUsdBalance)} />
          <Row label={<SGusd />} value={fmtGusdCompact(account.sGUsdBalance)} />
          <p className="pt-1 text-[10.5px] leading-relaxed text-dim">
            Full holdings on{" "}
            <Link href="/portfolio" className="text-data underline decoration-rule-strong underline-offset-2 hover:text-bright">
              Portfolio
            </Link>
            .
          </p>
        </dl>
      ) : (
        <p className="p-3.5 text-[11.5px] leading-relaxed text-dim">
          Connect from the system bar to trade this desk.
        </p>
      )}
    </TuiPanel>
  );
}

function Row({
  label,
  value,
  tone = "data",
}: {
  label: ReactNode;
  value: string;
  tone?: "data" | "wire";
}) {
  return (
    <div className="flex items-baseline justify-between border-b border-rule pb-1.5">
      <dt className="slug text-dim">{label}</dt>
      <dd className={`num text-[12px] ${tone === "wire" ? "text-wire" : "text-data"}`}>{value}</dd>
    </div>
  );
}
