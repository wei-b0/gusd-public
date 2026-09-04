"use client";

/**
 * Asset detail — understand one market in depth. The §6 head answers the
 * five questions at a glance (market price, Index price, premium, volume,
 * liquidity); the body carries the chart, premium/discount history,
 * statistics, a simple trade panel, recent trades, Index sources, and the
 * underlying GPU reference. Desktop is spatial; mobile is sequential tasks
 * via the tab strip.
 */

import { use, useState, type ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  pairName,
  parseAssetId,
  type Account,
  type AssetId,
  type AssetSpec,
  type Market,
  type MarketSnapshot,
  type MarketStats,
  type MarketTrade,
  type ProviderObservation,
} from "@/domain/types";
import {
  fmtAge,
  fmtClock,
  fmtFull,
  fmtGusd,
  fmtGusdCompact,
  fmtGusdPrecise,
  fmtNotional,
  fmtPctSigned,
  fmtStamp,
  fmtUnits,
  fmtUsdPrecise,
  isFlatPct,
} from "@/domain/format";
import { useAccount, useMarketSnapshot } from "@/data/services";
import { PriceChart } from "@/components/charts/price-chart";
import { BasisChart, buildBasisPoints } from "@/components/charts/basis-chart";
import { OrderSlip } from "@/components/markets/order-slip";
import { Gusd, SGusd } from "@/components/ui/pair";
import { TabBar } from "@/components/ui/tab-bar";
import { TickFlash } from "@/components/ui/tick-flash";
import { TuiPanel } from "@/components/ui/panel";

const RANGES = ["1D", "1W", "1M", "3M"] as const;
type Range = (typeof RANGES)[number];
const TABS = ["Overview", "Chart", "Trade", "Index", "Activity"] as const;

export default function AssetPage({ params }: { params: Promise<{ asset: string }> }) {
  const { asset: raw } = use(params);
  const assetId = parseAssetId(raw);
  if (!assetId) notFound();
  return <AssetDetail assetId={assetId} />;
}

function AssetDetail({ assetId }: { assetId: AssetId }) {
  const [range, setRange] = useState<Range>("1D");
  const [tab, setTab] = useState<string>("Overview");
  const snapshot = useMarketSnapshot(assetId, range);
  const account = useAccount();
  if (!snapshot) notFound();

  const m = snapshot.market;
  const premium = m.basisPct >= 0;
  const flat24 = isFlatPct(m.change24hPct);

  return (
    <div>
      <Breadcrumb asset={m.asset.id} stamp={snapshot.quality.updatedAt} />

      {/* Head — the five reads: market price, Index price, premium, volume, liquidity */}
      <header className="mt-5 flex flex-col gap-5 border-b border-rule-strong pb-5 md:flex-row md:items-baseline md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1 className="disp text-[34px] leading-none text-primary">{pairName(m.asset.id)}</h1>
            <span className="num text-[12.5px] text-dim">{m.asset.referenceSku}</span>
          </div>
          <p className="mt-2 max-w-prose text-[12.5px] leading-relaxed text-primary">{m.asset.note}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-baseline gap-x-8 gap-y-4 md:justify-end">
          <div>
            <p className="slug text-dim">Market Price</p>
            <p className="mt-1 flex items-baseline gap-1.5">
              <TickFlash value={m.marketPrice} className="disp block text-[30px] leading-none text-bright">
                {fmtGusdPrecise(m.marketPrice)}
              </TickFlash>
              <span className="num text-[11px] text-dim">gUSD</span>
            </p>
            <p
              className={`num mt-1 inline-flex items-baseline gap-1 text-[12px] ${
                flat24 ? "text-dim" : m.change24hPct >= 0 ? "text-up" : "text-down"
              }`}
            >
              {flat24 ? null : (
                <span aria-hidden className="text-[9px]">
                  {m.change24hPct >= 0 ? "▲" : "▼"}
                </span>
              )}
              {fmtPctSigned(m.change24hPct)} today
            </p>
          </div>
          <div>
            <p className="slug text-dim">Index Price</p>
            <TickFlash
              value={m.indexPrice}
              flash="wire"
              className="num mt-1 block text-[20px] leading-none text-wire"
            >
              {fmtUsdPrecise(m.indexPrice)}
            </TickFlash>
            <p className="num mt-1 text-[10px] text-dim">$ / GPU-hour</p>
          </div>
          <div>
            <p className={`slug ${premium ? "text-amber" : "text-wire"}`}>
              {premium ? "Premium" : "Discount"}
            </p>
            <p className={`num mt-1 text-[20px] font-bold leading-none ${premium ? "text-amber" : "text-wire"}`}>
              {fmtPctSigned(m.basisPct)}
            </p>
            <p className="num mt-1 text-[10px] text-dim">
              Volume {fmtGusdCompact(m.volume24hUsd)} gUSD · Liquidity {fmtGusdCompact(m.liquidityUsd)} gUSD
            </p>
          </div>
        </div>
      </header>

      {/* Mobile task switcher — desktop stays spatial */}
      <div className="mt-4 lg:hidden">
        <TabBar tabs={TABS.map((id) => ({ id, label: id }))} active={tab} onChange={setTab} label={`${m.asset.id} sections`} />
      </div>

      <Body snapshot={snapshot} range={range} onRange={setRange} account={account} tab={tab} />
    </div>
  );
}

function Body({
  snapshot,
  range,
  onRange,
  account,
  tab,
}: {
  snapshot: MarketSnapshot;
  range: Range;
  onRange: (r: Range) => void;
  account: Account;
  tab: string;
}) {
  const m = snapshot.market;
  // Grid items hide at the item level so hidden tracks create no rows or gaps;
  // panels inside the mixed cell hide individually (display:none paints no margins).
  const vis = (name: string) => `${tab === name ? "" : "hidden"} lg:block`;
  const cellVis = (names: string[]) =>
    (names.includes(tab) ? "" : "hidden") + " lg:block";
  return (
    <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[auto_1fr]">
      <div className={`min-w-0 lg:col-start-1 lg:row-start-1 ${cellVis(["Chart"])}`}>
        <Plate snapshot={snapshot} range={range} onRange={onRange} />
      </div>
      {/* The trade panel rides beside the plate on desktop; on mobile it is the Trade task. */}
      <aside className={`self-start lg:col-start-2 lg:row-start-1 ${vis("Trade")}`}>
        <TuiPanel no="02" title="Trade" meta="fee 6 bps">
          <OrderSlip assetId={m.asset.id} marketPrice={m.marketPrice} />
        </TuiPanel>
      </aside>
      <div className={`min-w-0 space-y-6 lg:col-start-1 lg:row-start-2 ${cellVis(["Overview", "Index", "Activity"])}`}>
        <div className={vis("Index")}>
          <PremiumHistory snapshot={snapshot} range={range} />
        </div>
        <div className={vis("Overview")}>
          <Statistics market={m} stats={snapshot.stats} />
        </div>
        <div className={vis("Index")}>
          <IndexSources snapshot={snapshot} />
        </div>
        <div className={vis("Activity")}>
          <Tape trades={snapshot.recentTrades} />
        </div>
        <div className={vis("Overview")}>
          <Reference asset={m.asset} />
        </div>
      </div>
      <aside className={`self-start lg:col-start-2 lg:row-start-2 ${vis("Trade")}`}>
        <TuiPanel title="Your position">
          <SessionPanel assetId={m.asset.id} account={account} />
        </TuiPanel>
      </aside>
    </div>
  );
}

function Plate({
  snapshot,
  range,
  onRange,
}: {
  snapshot: MarketSnapshot;
  range: Range;
  onRange: (r: Range) => void;
}) {
  return (
    <TuiPanel
      no="01"
      title="Price chart"
      meta="candles hourly · UTC"
      right={
        <div role="group" aria-label="Chart range" className="flex items-center">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              onClick={() => onRange(r)}
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
      <div className="p-2 pr-3">
        <PriceChart
          candles={snapshot.candles}
          index={snapshot.index}
          range={range}
          livePrice={snapshot.market.marketPrice}
          className="h-80 lg:h-[56vh] lg:min-h-95"
        />
      </div>
      <div className="border-t border-rule px-3.5 py-2">
        <p className="slug text-dim">Market price · Index price overlaid · band shows the gap</p>
      </div>
    </TuiPanel>
  );
}

function PremiumHistory({
  snapshot,
  range,
}: {
  snapshot: MarketSnapshot;
  range: Range;
}) {
  const points = buildBasisPoints(snapshot.candles, snapshot.index);
  const premium = snapshot.market.basisPct >= 0;
  return (
    <TuiPanel
      no="03"
      title="Premium / discount history"
      meta="market vs Index"
      right={
        <span className={`num text-[12px] font-bold ${premium ? "text-amber" : "text-wire"}`}>
          {premium ? "Premium" : "Discount"} {fmtPctSigned(snapshot.market.basisPct)}
        </span>
      }
    >
      <div className="p-2 pr-3">
        <BasisChart points={points} range={range} className="h-56 lg:h-[30vh] lg:min-h-56" />
      </div>
      <div className="border-t border-rule px-3.5 py-2">
        <p className="text-[11px] leading-relaxed text-dim">
          The gap between the market price and the Index price. Above zero the market trades at a
          premium; below zero, at a discount.
        </p>
      </div>
    </TuiPanel>
  );
}

function Statistics({ market: m, stats }: { market: Market; stats: MarketStats }) {
  const cells: { label: string; value: string }[] = [
    { label: "24h Volume", value: `${fmtGusdCompact(m.volume24hUsd)} gUSD` },
    { label: "Liquidity", value: `${fmtGusdCompact(m.liquidityUsd)} gUSD` },
    { label: "Open 24h", value: fmtGusdPrecise(stats.open24h) },
    { label: "High 24h", value: fmtGusdPrecise(stats.high24h) },
    { label: "Low 24h", value: fmtGusdPrecise(stats.low24h) },
    { label: "30d high", value: fmtGusdPrecise(stats.high30d) },
    { label: "30d low", value: fmtGusdPrecise(stats.low30d) },
    { label: "24h Trades", value: fmtFull(stats.trades24h) },
    { label: "Avg trade", value: `${fmtUnits(stats.avgTradeSize)} units` },
  ];
  return (
    <TuiPanel no="04" title="Market statistics" meta="trailing 30d window · prices in gUSD">
      <dl className="grid grid-cols-2 gap-x-8 gap-y-0 p-3.5 md:grid-cols-3">
        {cells.map((cell) => (
          <div
            key={cell.label}
            className="flex items-baseline justify-between border-b border-rule py-2"
          >
            <dt className="slug text-dim">{cell.label}</dt>
            <dd className="num text-[12.5px] text-data">{cell.value}</dd>
          </div>
        ))}
      </dl>
    </TuiPanel>
  );
}

function IndexSources({ snapshot }: { snapshot: MarketSnapshot }) {
  return (
    <TuiPanel
      no="05"
      title="Index sources"
      meta={`${snapshot.quality.sourcesLive}/${snapshot.quality.sourcesTotal} live · epoch ${snapshot.quality.epoch}`}
    >
      <div className="relative mt-2">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-rule text-left">
                <th scope="col" className="slug py-1.5 pl-3.5 pr-4 font-normal text-dim">Source</th>
                <th scope="col" className="slug px-2.5 py-1.5 text-right font-normal text-dim">Weight</th>
                <th scope="col" className="slug px-2.5 py-1.5 text-right font-normal text-dim">Observed</th>
                <th scope="col" className="slug px-2.5 py-1.5 text-right font-normal text-dim">Coverage</th>
                <th scope="col" className="slug py-1.5 pr-3.5 text-right font-normal text-dim">Age</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.providers.map((p) => (
                <tr key={p.id} className={p.status !== "live" ? "hatch" : undefined}>
                  <td className="py-2 pl-3.5 pr-4">
                    <span className="flex items-center gap-2 whitespace-nowrap">
                      <ProviderLamp status={p.status} />
                      <span className="text-[12.5px] text-data">{p.provider}</span>
                      {p.status !== "live" && (
                        <span className="slug border border-rule-strong px-1 py-0.5 text-[8.5px] text-dim">
                          {p.status === "stale" ? "Stale" : "Delayed"}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="num px-2.5 py-2 text-right text-data">{p.weightPct.toFixed(1)}%</td>
                  <td className="num px-2.5 py-2 text-right text-wire">
                    {fmtUsdPrecise(p.priceUsdPerGpuHour)}
                  </td>
                  <td className="num px-2.5 py-2 text-right text-data">{p.coveragePct.toFixed(0)}%</td>
                  <td className="num py-2 pr-3.5 text-right text-dim">
                    {fmtAge(p.lastObservedAt, snapshot.quality.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Advertise the horizontal swipe where the panel clips */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-[linear-gradient(to_left,var(--color-ground),transparent)] lg:hidden"
        />
      </div>
      <p className="px-3.5 pb-3.5 pt-3 text-[11.5px] leading-relaxed text-dim">
        Index Price is the weighted reference across these provider observations, published per
        epoch. Sources inform the benchmark — they never set the market price.
      </p>
    </TuiPanel>
  );
}

function ProviderLamp({ status }: { status: ProviderObservation["status"] }) {
  const glyph = status === "live" ? "●" : status === "delayed" ? "◐" : "○";
  const tone =
    status === "live" ? "text-up" : status === "delayed" ? "text-amber" : "text-dim";
  return (
    <span role="img" aria-label={status} className={`num text-[9px] leading-none ${tone}`}>
      {glyph}
    </span>
  );
}

function Tape({ trades }: { trades: MarketTrade[] }) {
  const rows = [...trades].slice(-14).reverse();
  return (
    <TuiPanel no="06" title="Recent trades" meta="newest first">
      <div className="border-t border-rule">
        {rows.map((trade) => (
          <TapeRow key={trade.id} trade={trade} />
        ))}
      </div>
    </TuiPanel>
  );
}

function TapeRow({ trade }: { trade: MarketTrade }) {
  const buy = trade.side === "buy";
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-rule px-3.5 py-1.5 last:border-b-0">
      <span className="num w-14 shrink-0 text-[11px] text-dim">{fmtClock(trade.t)}</span>
      <span className={`slug w-16 shrink-0 ${buy ? "text-up" : "text-down"}`}>
        <span aria-hidden className="mr-1 text-[8px]">{buy ? "▲" : "▼"}</span>
        {buy ? "Bought" : "Sold"}
      </span>
      <span className="num flex-1 whitespace-nowrap text-right text-[12.5px] text-data">
        {fmtUnits(trade.size)} @ {fmtGusdPrecise(trade.price)}
      </span>
      <span className="num w-24 shrink-0 text-right text-[11.5px] text-dim">
        {fmtNotional(trade.notional)} gUSD
      </span>
    </div>
  );
}

function Reference({ asset }: { asset: AssetSpec }) {
  const rows = [
    { label: "Reference SKU", value: asset.referenceSku },
    { label: "Vendor", value: asset.vendor === "nvidia" ? "NVIDIA" : "AMD" },
    { label: "Memory", value: `${asset.vramGb} GB` },
    { label: "Form factor", value: asset.formFactor },
  ];
  return (
    <TuiPanel no="07" title="Underlying GPU" meta="hardware reference">
      <dl className="grid grid-cols-2 gap-x-8 p-3.5 md:grid-cols-4">
        {rows.map((row) => (
          <div key={row.label} className="border-b border-rule py-2">
            <dt className="slug text-dim">{row.label}</dt>
            <dd className="num mt-1 text-[13px] text-data">{row.value}</dd>
          </div>
        ))}
      </dl>
    </TuiPanel>
  );
}

function SessionPanel({ assetId, account }: { assetId: AssetId; account: Account }) {
  const position = account.positions.find((p) => p.asset === assetId);
  if (!account.connected) {
    return (
      <div className="p-3.5">
        <div className="flex items-baseline justify-between border-b border-rule pb-2">
          <span className="slug border border-rule-strong px-1.5 py-0.5 text-[9px] text-dim">
            not connected
          </span>
        </div>
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-dim">
          Connect to see your balances and holdings in this market.
        </p>
      </div>
    );
  }
  return (
    <div className="p-3.5">
      <div className="flex items-baseline justify-between border-b border-rule pb-2">
        <span className="num text-[10.5px] text-dim">{account.label}</span>
      </div>
      <dl className="mt-2.5 space-y-1.5">
        <LedgerLine label={<Gusd />} value={fmtFull(account.gUsdBalance)} />
        <LedgerLine label={<SGusd />} value={fmtFull(account.sGUsdBalance)} />
        {position ? (
          <>
            <LedgerLine label="Holding" value={`${fmtUnits(position.size)} units`} />
            <LedgerLine label="Avg entry" value={fmtGusd(position.avgEntry)} />
          </>
        ) : (
          <p className="pt-1 text-[11.5px] text-dim">No position in this market yet.</p>
        )}
      </dl>
    </div>
  );
}

function LedgerLine({ label, value }: { label: ReactNode; value: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-rule pb-1.5">
      <dt className="slug text-dim">{label}</dt>
      <dd className="num text-[12.5px] text-data">{value}</dd>
    </div>
  );
}

function Breadcrumb({ asset, stamp }: { asset: string; stamp: number }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-baseline gap-2">
      <Link href="/markets" className="slug text-dim transition-colors hover:text-amber">
        [Markets]
      </Link>
      <span aria-hidden className="text-deep">/</span>
      <span aria-current="page" className="num text-[12px] text-data">{pairName(asset)}</span>
      <span className="num ml-auto hidden text-[10.5px] text-dim md:inline">
        {fmtStamp(stamp)}
      </span>
    </nav>
  );
}
