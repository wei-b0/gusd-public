"use client";

/**
 * Benchmarks — the published reference prices. Panel 01 is the board: one
 * row per GPU-hour class, and selecting a row opens its panel receipt inline
 * (the contributors, weights, methods, and exclusions behind the latest
 * candidate — there is no per-asset route). Panel 02 is the reference
 * series itself, fed from the feed's server-bucketed candles.
 */

import { useState } from "react";
import {
  ASSET_IDS,
  CHART_RANGES,
  RANGE_WINDOW_MS,
  indexName,
  type AssetId,
  type ChartRange,
  type IndexQuality,
  type Market,
} from "@/domain/types";
import {
  fmtAge,
  fmtGusdPrecise,
  fmtPctSigned,
  fmtStamp,
  fmtUsdPrecise,
  isFlatPct,
} from "@/domain/format";
import { useMarketSnapshot, useMarkets } from "@/data/services";
import { DATA_SOURCE, LIVE_MAX_AGE_MS, STALE_MAX_AGE_MS } from "@/data/oracle/config";
import { ORACLE_PANELS } from "@/data/oracle/panel-map";
import type { PanelProviderDto } from "@/data/oracle/dto";
import {
  useNowTick,
  useOracleSeries,
  useWirePanelProviders,
} from "@/components/oracle/use-oracle-feed";
import { IndexChart } from "@/components/charts/index-chart";
import { Gusd } from "@/components/ui/pair";
import { TuiPanel } from "@/components/ui/panel";

const RANGES = CHART_RANGES;

export function BenchmarksTab({ bench, onBench }: { bench: AssetId; onBench: (id: AssetId) => void }) {
  const markets = useMarkets();
  // Venue columns exist only where a market layer prices the rows (mock
  // universe); in oracle mode the board stays pure reference infrastructure.
  const hasVenue = markets.some((m) => m.marketPrice !== null);

  return (
    <>
      {/* 01 — the board + the selected benchmark's panel receipt */}
      <TuiPanel no="01" title="Index board" meta="weighted reference · not a market price">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-rule-strong text-left">
                <th scope="col" className="slug py-2 pl-3.5 pr-4 font-normal text-dim">Benchmark</th>
                <th scope="col" className="slug px-2.5 py-2 text-right font-normal text-dim">Index Price / GPU-hour</th>
                <th scope="col" className="slug px-2.5 py-2 text-right font-normal text-dim">24h</th>
                {hasVenue && (
                  <th scope="col" className="slug px-2.5 py-2 text-right font-normal text-dim">Premium / Discount</th>
                )}
                {hasVenue && (
                  <th scope="col" className="slug px-2.5 py-2 text-right font-normal text-dim">
                    Market Price <span className="tracking-normal normal-case">/ gUSD</span>
                  </th>
                )}
                <th scope="col" className="slug px-2.5 py-2 text-right font-normal text-dim">Sources</th>
                <th scope="col" className="slug py-2 pr-3.5 text-right font-normal text-dim">Updated</th>
              </tr>
            </thead>
            <tbody>
              {markets.map((m) => (
                <IndexBoardRow
                  key={m.asset.id}
                  market={m}
                  hasVenue={hasVenue}
                  selected={m.asset.id === bench}
                  onSelect={() => onBench(m.asset.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
        <PanelReceipt bench={bench} />
        <p className="px-3.5 pb-3.5 pt-3 text-[11.5px] leading-relaxed text-dim">
          Each benchmark is the weighted reference for its GPU-hour, built from provider
          observations. Select a benchmark to read its panel receipt — the contributors,
          weights, and screens behind the latest publication. Where a venue prices the asset
          separately, the gap to the Index prints as a premium or a discount.
        </p>
      </TuiPanel>

      {/* 02 — the reference series, server-bucketed from the feed's candles */}
      <div className="mt-5">
        <ReferenceHistory bench={bench} onBench={onBench} />
      </div>
    </>
  );
}

/** One board row; subscribes to the class snapshot for source-quality truth. */
function IndexBoardRow({
  market: m,
  hasVenue,
  selected,
  onSelect,
}: {
  market: Market;
  hasVenue: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const snapshot = useMarketSnapshot(m.asset.id, "15m");
  const q: IndexQuality | null = snapshot?.quality ?? null;
  const change = m.indexChange24hPct;
  const basis = m.basisPct;

  return (
    <tr
      className={`cursor-pointer border-b border-rule last:border-b-0 ${
        selected ? "bg-panel-deep" : "hover:bg-panel-deep"
      }`}
      onClick={onSelect}
    >
      <td className="py-2.5 pl-3.5 pr-4">
        <button
          type="button"
          aria-pressed={selected}
          onClick={onSelect}
          className="flex items-baseline gap-2 whitespace-nowrap text-left outline-none"
        >
          <span className={`num text-[13px] font-bold transition-colors ${selected ? "text-bright" : "text-data"}`}>
            {indexName(m.asset.id)}
          </span>
          <span className={`num text-[10px] ${selected ? "text-data" : "text-dim"}`}>
            {selected ? "receipt ▾" : "receipt ▸"}
          </span>
        </button>
      </td>
      <td className={`num px-2.5 py-2.5 text-right text-[13.5px] font-bold ${m.indexPrice === null ? "text-dim" : "text-wire"}`}>
        {m.indexPrice === null ? "—" : fmtUsdPrecise(m.indexPrice)}
      </td>
      <td
        className={`num px-2.5 py-2.5 text-right ${
          change === null || isFlatPct(change)
            ? "text-dim"
            : change >= 0
              ? "text-up"
              : "text-down"
        }`}
      >
        {change === null ? "—" : fmtPctSigned(change)}
      </td>
      {hasVenue && (
        <td
          className={`num px-2.5 py-2.5 text-right ${
            basis === null ? "text-dim" : basis >= 0 ? "text-amber" : "text-wire"
          }`}
        >
          {basis === null ? "—" : fmtPctSigned(basis)}
        </td>
      )}
      {hasVenue && (
        <td className="num px-2.5 py-2.5 text-right text-data">
          {m.marketPrice === null ? <span className="text-dim">—</span> : fmtGusdPrecise(m.marketPrice)}
        </td>
      )}
      <td className="num px-2.5 py-2.5 text-right text-data">
        {q ? `${q.sourcesLive}/${q.sourcesTotal}` : "—"}
      </td>
      <td className="num py-2.5 pr-3.5 text-right text-[10.5px] text-dim">
        {q ? fmtStamp(q.updatedAt) : "—"}
      </td>
    </tr>
  );
}

/**
 * The selected benchmark's panel receipt — GET /v1/prices/:gpu/providers as
 * a table: every contributor's weight, method, and screen statistics, plus
 * the window's exclusions. Kept in lockstep with the latest candidate by the
 * feed store. undefined = not fetched yet; null = the oracle answered "no
 * candidate ever computed".
 */
function PanelReceipt({ bench }: { bench: AssetId }) {
  const ref = ORACLE_PANELS[bench];
  const panel = useWirePanelProviders(ref?.gpuId ?? "");
  const now = useNowTick();

  const computedAt =
    panel === null || panel === undefined ? null : safeParse(panel.computedAt);

  return (
    <div className="border-t border-rule-strong">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3.5 pb-2 pt-2.5">
        <span className="slug text-amber">Panel receipt — {indexName(bench)}</span>
        <span className="num text-[10px] text-dim">
          {ref ? `GET /v1/prices/${ref.panelId}/providers` : "no settlement panel"}
        </span>
        <span className="num ml-auto text-[10px] text-dim">
          {computedAt === null ? "—" : fmtStamp(computedAt)}
        </span>
      </div>
      {!ref || panel === undefined ? (
        <p className="px-3.5 pb-3.5 text-[11.5px] leading-relaxed text-dim">
          {DATA_SOURCE === "oracle"
            ? "Reading the panel receipt…"
            : "The panel receipt prints when the oracle is connected."}
        </p>
      ) : panel === null ? (
        <p className="px-3.5 pb-3.5 text-[11.5px] leading-relaxed text-dim">
          No panel receipt yet — the oracle has not computed one for this benchmark.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-rule text-left">
                  <th scope="col" className="slug py-1.5 pl-3.5 pr-4 font-normal text-dim">Source</th>
                  <th scope="col" className="slug px-2.5 py-1.5 text-right font-normal text-dim">Weight</th>
                  <th scope="col" className="slug px-2.5 py-1.5 text-right font-normal text-dim">Method</th>
                  <th scope="col" className="slug px-2.5 py-1.5 text-right font-normal text-dim">σ</th>
                  <th scope="col" className="slug px-2.5 py-1.5 text-right font-normal text-dim" title="Observations feeding the provider's vote">Sample</th>
                  <th scope="col" className="slug px-2.5 py-1.5 text-right font-normal text-dim">Observed</th>
                  <th scope="col" className="slug py-1.5 pr-3.5 text-right font-normal text-dim">Executable</th>
                </tr>
              </thead>
              <tbody>
                {panel.providers.map((p) => (
                  <ReceiptRow key={p.providerId} p={p} now={now} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-3.5 pb-3.5 pt-2">
            <p className="slug text-dim">Exclusions</p>
            {panel.exclusions.length === 0 ? (
              <p className="num mt-1 text-[11px] text-dim">None this window.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {panel.exclusions.map((x) => (
                  <li key={x.providerId} className="num text-[11px] leading-relaxed">
                    <span className="text-data">{x.providerId}</span>
                    <span className="text-amber"> · {x.reason}</span>
                    {x.detail && <span className="text-dim"> · {x.detail}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ReceiptRow({ p, now }: { p: PanelProviderDto; now: number | null }) {
  const observedAt = p.lastObservedAt === null ? null : safeParse(p.lastObservedAt);
  const valid = observedAt !== null && now !== null;
  const age = valid ? now - observedAt : null;
  // Lamp semantics follow the desk's Index sources: fresh within the
  // publisher's gate is live, within the carry-forward window delayed, past
  // it stale — and an unparseable stamp is delayed, never live (freshness we
  // cannot vouch for is not live).
  const status =
    age === null
      ? "delayed"
      : age <= LIVE_MAX_AGE_MS
        ? "live"
        : age <= STALE_MAX_AGE_MS
          ? "delayed"
          : "stale";

  return (
    <tr className="border-b border-rule last:border-b-0">
      <td className="py-2 pl-3.5 pr-4">
        <span className="flex items-center gap-2 whitespace-nowrap">
          <span
            role="img"
            aria-label={status}
            className={`num text-[9px] leading-none ${
              status === "live" ? "text-up" : status === "delayed" ? "text-amber" : "text-dim"
            }`}
          >
            {status === "live" ? "●" : status === "delayed" ? "◐" : "○"}
          </span>
          <span className="text-[12.5px] text-data">{p.name}</span>
        </span>
      </td>
      <td className="num px-2.5 py-2 text-right text-data">{p.weightPct.toFixed(1)}%</td>
      <td className="num px-2.5 py-2 text-right text-[11px] text-dim">{p.method}</td>
      <td className="num px-2.5 py-2 text-right text-data">
        {p.sigma === null ? "—" : p.sigma.toFixed(4)}
      </td>
      <td className="num px-2.5 py-2 text-right text-data">{p.sampleSize}</td>
      <td className="num px-2.5 py-2 text-right text-dim">
        {valid ? fmtAge(observedAt, now) : "—"}
      </td>
      <td className="num py-2 pr-3.5 text-right">
        {p.executable ? (
          <span className="text-data">yes</span>
        ) : (
          <span className="text-dim" title="Rate-card priced — 0.6 weight">rate card</span>
        )}
      </td>
    </tr>
  );
}

/** The reference series panel: benchmark and grain switchers over the feed's
 *  server-bucketed candles (useOracleSeries — the market snapshot's
 *  `index: []` is deliberate, and this is the surface that reads the
 *  buckets instead). */
function ReferenceHistory({ bench, onBench }: { bench: AssetId; onBench: (id: AssetId) => void }) {
  const [range, setRange] = useState<ChartRange>("1h");
  const points = useOracleSeries(bench, range);
  // Real publication history can be much shallower than the selected range —
  // say so rather than let a short line imply a quiet market. The mock
  // series spans its whole range, so it never trips this.
  const span = points !== null && points.length >= 2 ? points[points.length - 1]!.t - points[0]!.t : 0;
  const shallow = points !== null && span < RANGE_WINDOW_MS[range] - 3_600_000;

  return (
    <TuiPanel
      no="02"
      title={
        <>
          <Gusd /> {bench} Index
        </>
      }
      meta="reference series"
      right={
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
          <div role="group" aria-label="History benchmark" className="flex items-center">
            {ASSET_IDS.filter((id) => id in ORACLE_PANELS).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={bench === id}
                onClick={() => onBench(id)}
                className={`num px-2 py-1 text-[11px] transition-colors ${
                  bench === id ? "text-wire underline decoration-wire underline-offset-4" : "text-dim hover:text-data"
                }`}
              >
                {id}
              </button>
            ))}
          </div>
          <div role="group" aria-label="History interval" className="flex items-center">
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
        </div>
      }
    >
      {points !== null ? (
        <div className="p-2 pr-3">
          <IndexChart points={points} range={range} className="h-72 lg:h-[46vh] lg:min-h-72" />
        </div>
      ) : (
        <p className="num p-6 text-center text-[11.5px] text-dim">
          {DATA_SOURCE === "oracle"
            ? "No series yet — the oracle's candles for this range have not loaded."
            : "The reference series prints when the oracle is connected."}
        </p>
      )}
      <div className="border-t border-rule px-3.5 py-2">
        {shallow && (
          <p className="slug text-amber">
            Oracle history spans{" "}
            {span < 3_600_000 ? "<1h" : `~${Math.round(span / 3_600_000)}h`} — shallower than
            the selected range; the series fills as candidates accrue.
          </p>
        )}
        <p className="slug text-dim">The Index alone — market price charts live on each market's desk</p>
      </div>
    </TuiPanel>
  );
}

/** Date.parse that never invents a timestamp for malformed wire input. */
function safeParse(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}
