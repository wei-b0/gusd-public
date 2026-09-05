"use client";

/**
 * Oracle sheet for one GPU-hour class — cyan-led. The benchmark is the
 * headline; the market price and the premium/discount gap ride underneath;
 * the full provider panel, weights, and observation ages fill the body.
 */

import { use, useState } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CHART_RANGES,
  RANGE_WINDOW_MS,
  indexName,
  pairName,
  parseAssetId,
  type AssetId,
  type ChartRange,
  type MarketSnapshot,
  type ProviderObservation,
} from "@/domain/types";
import {
  fmtAge,
  fmtGusdCompact,
  fmtGusdPrecise,
  fmtPctSigned,
  fmtUsdPrecise,
  isFlatPct,
} from "@/domain/format";
import { useMarketSnapshot } from "@/data/services";
import { IndexChart } from "@/components/charts/index-chart";
import { IndexStatusChip } from "@/components/ui/index-status-chip";
import { TuiPanel } from "@/components/ui/panel";

const RANGES = CHART_RANGES;
type Range = ChartRange;

export default function IndexAssetPage({ params }: { params: Promise<{ asset: string }> }) {
  const { asset: raw } = use(params);
  const assetId = parseAssetId(raw);
  if (!assetId) notFound();
  return <IndexSheet assetId={assetId} />;
}

function IndexSheet({ assetId }: { assetId: AssetId }) {
  const [range, setRange] = useState<Range>("15m");
  const snapshot = useMarketSnapshot(assetId, range);
  if (!snapshot) notFound();

  const m = snapshot.market;
  const basis = m.basisPct;
  const premium = basis !== null && basis >= 0;
  const flat24 = m.indexChange24hPct === null ? true : isFlatPct(m.indexChange24hPct);
  // Real publication history can be much shallower than the selected range
  // (500 candidates is only hours of depth) — say so rather than let a short
  // line imply a quiet market. The mock series spans its whole range, so it
  // never trips this.
  const points = snapshot.index;
  const span = points.length >= 2 ? points[points.length - 1]!.t - points[0]!.t : 0;
  const shallow = span < RANGE_WINDOW_MS[range] - 3_600_000;

  return (
    <div>
      <nav aria-label="Breadcrumb" className="flex items-baseline gap-2">
        <Link href="/oracle" className="slug text-dim transition-colors hover:text-amber">
          [Oracle]
        </Link>
        <span aria-hidden className="text-deep">/</span>
        <span aria-current="page" className="num text-[12px] text-data">{indexName(m.asset.id)}</span>
        <span className="slug ml-2 border border-rule-strong px-1.5 py-0.5 text-[9px] text-dim">
          Benchmark
        </span>
        <span className="num ml-auto hidden text-[10.5px] text-dim md:inline">
          {m.volume24hUsd === null
            ? "no market tape yet · venue volume pending"
            : `${fmtGusdCompact(m.volume24hUsd)} gUSD traded on the market · 24h`}
        </span>
      </nav>

      {/* Cyan-led head: the Index is the headline here */}
      <header className="mt-5 flex flex-col gap-5 border-b border-rule-strong pb-5 md:flex-row md:items-baseline md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1 className="disp text-[34px] leading-none text-primary">{indexName(m.asset.id)}</h1>
            <span className="num text-[12.5px] text-dim">Reference benchmark · $ / GPU-hour</span>
          </div>
          <p className="mt-2 max-w-prose text-[12.5px] leading-relaxed text-primary">{m.asset.note}</p>
        </div>
        <div className="flex shrink-0 items-baseline gap-7 md:text-right">
          <div>
            <p className="slug flex items-baseline gap-1.5 text-dim">
              Index Price <IndexStatusChip status={m.indexStatus} />
            </p>
            {m.indexPrice === null ? (
              <p className="num mt-1 text-[30px] font-bold leading-none text-dim">—</p>
            ) : (
              <p className="num mt-1 text-[30px] font-bold leading-none text-wire">
                {fmtUsdPrecise(m.indexPrice)}
              </p>
            )}
            <p className="num mt-1 text-[10px] text-dim">$ / GPU-hour</p>
            <p
              className={`num mt-1 text-[12px] ${
                m.indexChange24hPct === null || flat24
                  ? "text-dim"
                  : m.indexChange24hPct >= 0
                    ? "text-up"
                    : "text-down"
              }`}
            >
              {m.indexChange24hPct === null ? "—" : fmtPctSigned(m.indexChange24hPct)} · 24h
            </p>
          </div>
          {/* A venue price is a market-layer fact: shown where a market data
              source fills it, absent — not "—" — where the benchmark is the
              market's only price. */}
          {m.marketPrice !== null && (
            <div>
              <p className="slug text-dim">
                Market Price <span className="tracking-normal normal-case">/ gUSD</span>
              </p>
              <p className="num mt-1 text-[17px] leading-none text-data">{fmtGusdPrecise(m.marketPrice)}</p>
              <p className={`num mt-1 text-[10.5px] font-bold ${basis === null ? "text-dim" : premium ? "text-amber" : "text-wire"}`}>
                {basis === null ? "Basis —" : `${premium ? "Premium" : "Discount"} ${fmtPctSigned(basis)}`}
              </p>
            </div>
          )}
        </div>
      </header>

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          {/* 01 — the reference series */}
          <TuiPanel
            no="01"
            title="Index history"
            meta="weighted reference"
            right={
              <div role="group" aria-label="Chart interval" className="flex items-center">
                {RANGES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={range === r}
                    onClick={() => setRange(r)}
                    className={`num border-b px-2.5 py-1 text-[11px] transition-colors ${
                      range === r ? "border-amber text-amber" : "border-transparent text-dim hover:text-data"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            }
          >
            <div className="p-2 pr-3">
              <IndexChart
                points={snapshot.index}
                range={range}
                className="h-80 lg:h-[56vh] lg:min-h-95"
              />
            </div>
            <div className="border-t border-rule px-3.5 py-2">
              {shallow && (
                <p className="slug text-amber">
                  Oracle history spans{" "}
                  {span < 3_600_000 ? "<1h" : `~${Math.round(span / 3_600_000)}h`} — shallower
                  than the selected range; the series fills as candidates accrue.
                </p>
              )}
              <p className="slug text-dim">
                The Index alone — the market's desk on{" "}
                <Link
                  href={`/terminal/${m.asset.id}`}
                  className="text-data underline decoration-rule-strong underline-offset-2 hover:text-amber"
                >
                  [Terminal] {pairName(m.asset.id)}
                </Link>
              </p>
            </div>
          </TuiPanel>

          {/* 02 — the full provider panel */}
          <TuiPanel
            no="02"
            title="Index sources"
            meta={
              snapshot.quality
                ? `${snapshot.quality.sourcesLive}/${snapshot.quality.sourcesTotal} live${snapshot.quality.publication ? ` · #${snapshot.quality.publication}` : ""}`
                : "—"
            }
          >
            <div className="mt-2">
              <ProviderTable snapshot={snapshot} />
            </div>
            <p className="px-3.5 pb-3.5 pt-3 text-[11.5px] leading-relaxed text-dim">
              Providers print observations each epoch; the Index weighs them per class.
              A source that lags is marked and its influence ages out — it never sets a price.
            </p>
          </TuiPanel>
        </div>

        {/* Right rail — weighting and the data note */}
        <div className="space-y-5 self-start">
          <TuiPanel no="03" title="Weighting" meta="fixed per class">
            <div className="space-y-2.5 p-3.5">
              {snapshot.providers.map((p) => (
                <div key={p.id}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[12px] text-data">{p.provider}</span>
                    <span className={`num shrink-0 text-[12px] font-bold ${p.weightPct === null ? "text-dim" : "text-wire"}`}>
                      {p.weightPct === null ? "—" : `${p.weightPct.toFixed(1)}%`}
                    </span>
                  </div>
                  {p.weightPct !== null && (
                    <p
                      aria-hidden
                      className="num mt-1 text-[10px] leading-none text-dim"
                      title={`${p.weightPct.toFixed(1)}% of the Index`}
                    >
                      {weightBar(p.weightPct)}
                    </p>
                  )}
                </div>
              ))}
              <p className="pt-1 text-[10.5px] leading-relaxed text-dim">
                Weights are the prototype's fixed panel shape; the protocol's final weighting
                is still being specified.
              </p>
            </div>
          </TuiPanel>

          <TuiPanel no="04" title="Data note" meta="interface catalog">
            <div className="space-y-2 p-3.5 text-[11.5px] leading-relaxed text-dim">
              <p>
                Provider observations feed the Index per epoch. The interface catalog and a
                sample payload live on the{" "}
                <Link href="/oracle" className="text-data underline decoration-rule-strong underline-offset-2 hover:text-bright">
                  Oracle board
                </Link>
                .
              </p>
            </div>
          </TuiPanel>
        </div>
      </div>
    </div>
  );
}

function weightBar(weightPct: number): string {
  const full = Math.round((weightPct / 40) * 10);
  return "█".repeat(Math.max(1, Math.min(10, full))) + "░".repeat(Math.max(0, 10 - full));
}

function ProviderTable({ snapshot }: { snapshot: MarketSnapshot }) {
  return (
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
            <ProviderRow key={p.id} p={p} now={snapshot.quality?.updatedAt ?? null} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProviderRow({ p, now }: { p: ProviderObservation; now: number | null }) {
  return (
    <tr className={p.status !== "live" ? "hatch" : undefined}>
      <td className="py-2 pl-3.5 pr-4">
        <span className="flex items-center gap-2 whitespace-nowrap">
          <span
            role="img"
            aria-label={p.status}
            className={`num text-[9px] leading-none ${
              p.status === "live" ? "text-up" : p.status === "delayed" ? "text-amber" : "text-dim"
            }`}
          >
            {p.status === "live" ? "●" : p.status === "delayed" ? "◐" : "○"}
          </span>
          <span className="text-[12.5px] text-data">{p.provider}</span>
          {p.status !== "live" && (
            <span className="slug border border-rule-strong px-1 py-0.5 text-[8.5px] text-dim">
              {p.status === "stale" ? "Stale" : "Delayed"}
            </span>
          )}
        </span>
      </td>
      <td className="num px-2.5 py-2 text-right text-data">
        {p.weightPct === null ? "—" : `${p.weightPct.toFixed(1)}%`}
      </td>
      <td className="num px-2.5 py-2 text-right text-wire">
        {p.priceUsdPerGpuHour === null ? "—" : fmtUsdPrecise(p.priceUsdPerGpuHour)}
      </td>
      <td className="num px-2.5 py-2 text-right text-data">
        {p.coveragePct === null ? "—" : `${p.coveragePct.toFixed(0)}%`}
      </td>
      <td className="num py-2 pr-3.5 text-right text-dim">
        {p.lastObservedAt === null || now === null ? "—" : fmtAge(p.lastObservedAt, now)}
      </td>
    </tr>
  );
}
