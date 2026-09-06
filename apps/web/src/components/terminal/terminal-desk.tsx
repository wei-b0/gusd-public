"use client";

/**
 * TerminalDesk — the one roof: analyse and execute a market in a single
 * dense composition. The desk is deliberately the only surface with depth
 * and a trade ticket: the chart, statistics, the Index feed, both tapes,
 * the GPU reference, and the order slip. There is no unbound desk:
 * `/terminal` 308s to the default desk (H100), and the markets rail
 * navigates, so every desk has the market's own URL. Desktop is spatial;
 * mobile is sequential tasks via the tab strip.
 */

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  CHART_RANGES,
  marketMove24h,
  pairName,
  parseAssetId,
  type AssetId,
  type AssetSpec,
  type ChartRange,
  type Market,
  type MarketStats,
  type MarketTrade,
} from "@/domain/types";
import {
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
import { useAccount, useMarketSnapshot, useMarkets, useServices } from "@/data/services";
import { TvPriceChart } from "@/components/charts/tv-price-chart";
import { OrderSlip } from "@/components/markets/order-slip";
import { AllTape } from "@/components/markets/all-tape";
import { IndexStatusChip } from "@/components/ui/index-status-chip";
import { Gusd, Pair, SGusd } from "@/components/ui/pair";
import { TabBar } from "@/components/ui/tab-bar";
import { TickFlash } from "@/components/ui/tick-flash";
import { TuiPanel } from "@/components/ui/panel";

const RANGES = CHART_RANGES;
const TABS = ["Overview", "Chart", "Trade", "Activity"] as const;

export function TerminalDesk({ asset }: { asset: AssetId }) {
  // The bound market comes from the route — the rail's links are the switch.
  const [range, setRange] = useState<ChartRange>("5m");
  const [tab, setTab] = useState<string>("Overview");
  const markets = useMarkets();
  const snapshot = useMarketSnapshot(asset, range);
  const account = useAccount();

  if (!snapshot) return null;
  const m = snapshot.market;
  const basis = m.basisPct;
  const premium = basis !== null && basis >= 0;
  // The venue leg: absent without a market data source — then the benchmark
  // is the desk's one price.
  const hasMarket = m.marketPrice !== null;
  const flat24 = isFlatPct(m.change24hPct);
  const flatIndex24 = isFlatPct(m.indexChange24hPct);

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
        {/* Left rail — the markets, the session's position here, the hardware.
            The rail tiles its column: the Markets frame grows to the row's
            height (the tallest column's), so the rail bottoms out with the
            plate and the trade rail instead of stranding ground before the
            statistics strip — slack lives inside the frame, beneath the
            list, the way a board's empty quota does. */}
        <div
          className={`order-4 space-y-5 lg:order-1 lg:flex lg:flex-col ${
            tab === "Overview" ? "" : "hidden"
          } lg:block`}
        >
          <div className="lg:grow">
            <TuiPanel
              no="01"
              title="Markets"
              meta={`${markets.length} markets`}
              className="lg:flex lg:h-full lg:flex-col"
            >
              <div className="lg:flex-1">
                {markets.map((mk) => {
                  const active = mk.asset.id === asset;
                  const move = marketMove24h(mk);
                  const flat = isFlatPct(move);
                  return (
                    <Link
                      key={mk.asset.id}
                      href={`/terminal/${mk.asset.id}`}
                      aria-current={active ? "page" : undefined}
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
                          move === null || flat ? "text-dim" : move >= 0 ? "text-up" : "text-down"
                        }`}
                      >
                        {move === null ? (
                          "—"
                        ) : (
                          <TickFlash value={move} precision={2} className="inline-block">
                            {fmtPctSigned(move)}
                          </TickFlash>
                        )}
                        {move === null || flat ? null : (
                          <span aria-hidden className="text-[8px]">
                            {move >= 0 ? "▲" : "▼"}
                          </span>
                        )}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </TuiPanel>
          </div>

          <div>
            <PositionPanel asset={asset} account={account} />
          </div>

          <div>
            <Reference asset={m.asset} />
          </div>
        </div>

        {/* Center — the plate. The panel is a flex column that fills the
            grid row, and the chart is its flex-1 body: the row's height is
            the tallest column's (ticket + Index feed), so the plate bottoms
            out with the right rail at every viewport instead of freezing at
            a vh height and stranding dead space beneath it. */}
        <div className={`order-1 min-w-0 lg:order-2 ${cellVis(["Chart"])}`}>
          <div className="flex h-full flex-col">
            <TuiPanel
              no="02"
              className="flex h-full flex-col"
              bodyClassName="flex min-h-0 flex-1 flex-col"
              title={<Pair id={m.asset.id} />}
              meta={`${hasMarket ? "hourly" : range} candles · UTC`}
              right={
                <div role="group" aria-label="Chart interval" className="flex items-center">
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
                {m.marketPrice === null ? (
                  /* No venue leg: the Index is the desk's price — wire hero. */
                  <>
                    <span className="inline-flex items-baseline gap-1.5">
                      {m.indexPrice === null ? (
                        <span className="disp text-[26px] leading-none text-dim">—</span>
                      ) : (
                        <TickFlash
                          value={m.indexPrice}
                          precision={4}
                          arrow="hold"
                          className="disp text-[26px] leading-none text-wire"
                        >
                          {fmtUsdPrecise(m.indexPrice)}
                        </TickFlash>
                      )}
                      <span className="num text-[11px] text-dim">/ GPU-hour</span>
                    </span>
                    {m.indexChange24hPct !== null ? (
                      <span
                        className={`num inline-flex items-baseline gap-1 text-[12px] ${
                          flatIndex24 ? "text-dim" : m.indexChange24hPct >= 0 ? "text-up" : "text-down"
                        }`}
                      >
                        <TickFlash value={m.indexChange24hPct} precision={2} className="inline-block">
                          {fmtPctSigned(m.indexChange24hPct)}
                        </TickFlash>
                        {flatIndex24 ? null : (
                          <span aria-hidden className="text-[9px]">
                            {m.indexChange24hPct >= 0 ? "▲" : "▼"}
                          </span>
                        )}{" "}
                        · 24h
                      </span>
                    ) : null}
                  </>
                ) : (
                  <>
                    <span className="inline-flex items-baseline gap-1.5">
                      <TickFlash
                        value={m.marketPrice}
                        precision={4}
                        arrow="hold"
                        className="disp text-[26px] leading-none text-bright"
                      >
                        {fmtGusdPrecise(m.marketPrice)}
                      </TickFlash>
                      <span className="num text-[11px] text-dim">gUSD</span>
                    </span>
                    <span
                      className={`num inline-flex items-baseline gap-1 text-[12px] ${
                        m.change24hPct === null || flat24 ? "text-dim" : m.change24hPct >= 0 ? "text-up" : "text-down"
                      }`}
                    >
                      {m.change24hPct === null ? (
                        "—"
                      ) : (
                        <TickFlash value={m.change24hPct} precision={2} className="inline-block">
                          {fmtPctSigned(m.change24hPct)}
                        </TickFlash>
                      )}
                      {m.change24hPct === null || flat24 ? null : (
                        <span aria-hidden className="text-[9px]">
                          {m.change24hPct >= 0 ? "▲" : "▼"}
                        </span>
                      )}{" "}
                      · 24h
                    </span>
                    <span className="inline-flex items-baseline gap-1.5">
                      <span className="slug flex items-baseline gap-1.5 text-dim">
                        Index <IndexStatusChip status={m.indexStatus} />
                      </span>
                      {m.indexPrice === null ? (
                        <span className="num text-[14px] leading-none text-dim">—</span>
                      ) : (
                        <TickFlash
                          value={m.indexPrice}
                          precision={4}
                          className="num text-[14px] leading-none text-wire"
                        >
                          {fmtUsdPrecise(m.indexPrice)}
                        </TickFlash>
                      )}
                    </span>
                  </>
                )}
                {/* Basis needs a venue leg; without one there is no gap — the
                    span stays off the desk rather than printing "—". */}
                {hasMarket && (
                  <span
                    className={`num text-[12px] font-bold ${
                      basis === null ? "text-dim" : premium ? "text-amber" : "text-wire"
                    }`}
                  >
                    {basis === null ? "Basis —" : `${premium ? "Premium" : "Discount"} ${fmtPctSigned(basis)}`}
                  </span>
                )}
                {hasMarket && (
                  <span className="num text-[11.5px] text-dim">
                    Volume {m.volume24hUsd === null ? "—" : fmtGusdCompact(m.volume24hUsd)} gUSD · Liquidity{" "}
                    {m.liquidityUsd === null ? "—" : fmtGusdCompact(m.liquidityUsd)} gUSD
                  </span>
                )}
              </div>
              <div className="min-h-0 flex-1 p-2 pr-3">
                <TvPriceChart
                  asset={asset}
                  range={range}
                  className="h-full min-h-96 lg:min-h-95"
                />
              </div>
              <div className="border-t border-rule px-3.5 py-2">
                <p className="slug text-dim">
                  Benchmark series · candles from the canonical benchmark history
                </p>
              </div>
            </TuiPanel>
          </div>
        </div>

        {/* Right rail — the trade, then the Index feed. One task on mobile
            too: the feed is the ticket's reference leg, exactly where it
            sits on the desktop rail. */}
        <div className={`order-2 space-y-5 lg:order-3 ${cellVis(["Trade"])}`}>
          <div className={vis("Trade")}>
            <TuiPanel no="03" title="Trade" meta={<TradeMeta assetId={m.asset.id} />}>
              <OrderSlip assetId={m.asset.id} referencePrice={m.marketPrice ?? m.indexPrice} />
            </TuiPanel>
          </div>

          <div className={vis("Trade")}>
            <TuiPanel
              title="Index feed"
              meta={snapshot.quality ? `${snapshot.quality.sourcesLive}/${snapshot.quality.sourcesTotal} live` : "—"}
            >
              <div className="space-y-1.5 p-3.5">
                <div className="flex items-baseline justify-between border-b border-rule pb-2">
                  <span className="slug text-dim">
                    <Gusd /> {m.asset.id} Index
                  </span>
                  {m.indexPrice === null ? (
                    <span className="num text-[16px] font-bold leading-none text-dim">—</span>
                  ) : (
                    <TickFlash
                      value={m.indexPrice}
                      precision={4}
                      className="num text-[16px] font-bold leading-none text-wire"
                    >
                      {fmtUsdPrecise(m.indexPrice)}
                    </TickFlash>
                  )}
                </div>
                <Row
                  label="Publication"
                  value={
                    snapshot.quality?.publication ? (
                      /* One cyan pulse per real landing — the hash changes only
                         when data arrives, independent of any price moving. */
                      <TickFlash value={snapshot.quality.publication} flash="wire" className="inline-block">
                        {`#${snapshot.quality.publication}`}
                      </TickFlash>
                    ) : (
                      "—"
                    )
                  }
                  tone="wire"
                />
                <Row
                  label="Updated"
                  value={snapshot.quality ? fmtStamp(snapshot.quality.updatedAt) : "—"}
                  tone="wire"
                />
                <p className="pt-1 text-[10.5px] leading-relaxed text-dim">
                  Provider detail on the{" "}
                  <Link
                    href={`/oracle?tab=benchmarks&bench=${m.asset.id}`}
                    className="text-data underline decoration-rule-strong underline-offset-2 hover:text-bright"
                  >
                    oracle Benchmarks tab
                  </Link>
                  .
                </p>
              </div>
            </TuiPanel>
          </div>
        </div>

        {/* Row two — the statistics strip, spanning the full width. The dl
            tiles into listing-board cells so the desk's widest band keeps the
            desk's density instead of stretching four sparse pairs across it.
            The order utilities keep the mobile stack (rail 4, plate 1, right
            rail 2) ahead of the depth zones on every task. */}
        <div className={`order-6 lg:order-4 lg:col-span-3 ${cellVis(["Overview"])}`}>
          <Statistics market={m} stats={snapshot.stats} />
        </div>

        {/* Full-width depth — the activity zone */}
        <div className={`order-8 lg:order-5 lg:col-span-3 ${cellVis(["Activity"])}`}>
          <Tape trades={snapshot.recentTrades} />
        </div>
        <div className={`order-9 lg:order-6 lg:col-span-3 ${cellVis(["Activity"])}`}>
          <TuiPanel no="07" title="All-market tape" meta="all markets · newest first">
            <AllTape />
          </TuiPanel>
        </div>
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
          {/* No cost-basis source pre-indexer: null prints "—", never 0. */}
          <Row
            label="Avg entry"
            value={position ? (position.avgEntry === null ? "—" : fmtGusd(position.avgEntry)) : "—"}
          />
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

/**
 * The Trade panel's fee-schedule line — the market's onchain fee schedule
 * (LP + protocol + issuance). It names the market's rates, not any one
 * quote's fees; the slip's ledger carries what a specific fill incurs.
 * "—" while unregistered.
 */
function TradeMeta({ assetId }: { assetId: string }) {
  const { trading } = useServices();
  const [meta, setMeta] = useState<string>("—");
  useEffect(() => {
    const asset = parseAssetId(assetId);
    if (!asset) return;
    let alive = true;
    trading
      .describeAsset(asset)
      .then((a) => {
        if (alive) {
          setMeta(
            a
              ? `schedule ${(a.poolFeeBps / 100).toFixed(2)}% LP · ${(a.hookFeeBps / 100).toFixed(2)}% protocol · ${(a.issuanceFeeBps / 100).toFixed(2)}% issuance`
              : "unregistered",
          );
        }
      })
      .catch(() => {
        if (alive) setMeta("—");
      });
    return () => {
      alive = false;
    };
  }, [trading, assetId]);
  return <span className="num text-[10px] text-dim">{meta}</span>;
}

/* ---------------------------------------------------------------------------
 * Depth panels folded in from the retired market detail page. They keep the
 * market page's grammar (panel + caption + honesty empty-states) on the desk.
 * ------------------------------------------------------------------------- */

function Statistics({ market: m, stats }: { market: Market; stats: MarketStats }) {
  const hasMarket = m.marketPrice !== null;
  // Venue stats price in gUSD; benchmark window stats in USD per GPU-hour.
  const price = (n: number | null) =>
    n === null ? "—" : hasMarket ? fmtGusdPrecise(n) : fmtUsdPrecise(n);
  const cells: { label: string; value: string }[] = [
    { label: "24h Volume", value: m.volume24hUsd === null ? "—" : `${fmtGusdCompact(m.volume24hUsd)} gUSD` },
    { label: "Liquidity", value: m.liquidityUsd === null ? "—" : `${fmtGusdCompact(m.liquidityUsd)} gUSD` },
    { label: "Open 24h", value: price(stats.open24h) },
    { label: "High 24h", value: price(stats.high24h) },
    { label: "Low 24h", value: price(stats.low24h) },
    { label: "30d high", value: price(stats.high30d) },
    { label: "30d low", value: price(stats.low30d) },
    { label: "24h Trades", value: stats.trades24h === null ? "—" : fmtFull(stats.trades24h) },
    { label: "Avg trade", value: stats.avgTradeSize === null ? "—" : `${fmtUnits(stats.avgTradeSize)} units` },
  ];
  return (
    <TuiPanel
      no="05"
      title="Market statistics"
      meta={hasMarket ? "trailing 30d window · prices in gUSD" : "trailing windows · $ / GPU-hour"}
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-0 p-3.5 md:grid-cols-3 lg:grid-cols-5">
        {cells.map((cell) => (
          <div
            key={cell.label}
            className="flex items-baseline justify-between gap-2 border-b border-rule py-2"
          >
            <dt className="slug text-dim">{cell.label}</dt>
            <dd className="num text-[12.5px] text-data">{cell.value}</dd>
          </div>
        ))}
      </dl>
      {!hasMarket && (
        <p className="px-3.5 pb-3.5 text-[11.5px] leading-relaxed text-dim">
          Window stats derive from the benchmark's own series and fill as it accrues; trade counts
          wait for the market layer.
        </p>
      )}
    </TuiPanel>
  );
}

function Tape({ trades }: { trades: MarketTrade[] }) {
  const rows = [...trades].slice(-14).reverse();
  return (
    <TuiPanel no="06" title="Recent trades" meta="this market · newest first">
      <div className="border-t border-rule">
        {rows.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-[11.5px] text-dim">
            No trades yet — the tape prints when the venue goes live.
          </p>
        ) : (
          rows.map((trade) => <TapeRow key={trade.id} trade={trade} />)
        )}
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
  return (
    <TuiPanel no="04" title="Underlying GPU" meta="hardware reference">
      <div className="space-y-1.5 p-3.5">
        <Row label="Reference SKU" value={asset.referenceSku} />
        <Row label="Vendor" value={asset.vendor === "nvidia" ? "NVIDIA" : "AMD"} />
        <Row label="Memory" value={`${asset.vramGb} GB`} />
        <Row label="Form factor" value={asset.formFactor} />
      </div>
    </TuiPanel>
  );
}

function Row({
  label,
  value,
  tone = "data",
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: "data" | "wire";
}) {
  return (
    <div className="flex items-baseline justify-between border-b border-rule pb-1.5">
      <dt className="slug text-dim">{label}</dt>
      <dd className={`num text-[12px] ${tone === "wire" ? "text-wire" : "text-data"}`}>{value}</dd>
    </div>
  );
}
