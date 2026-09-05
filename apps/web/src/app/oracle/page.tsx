"use client";

/**
 * Oracle — the reference layer, in pipeline order: it observes GPU pricing
 * inputs, produces the Index benchmarks from them, publishes per epoch, and
 * exposes the benchmarks and related data through programmatic interfaces.
 * The board leads; the market price is the guest. Index (benchmarks) and
 * Data (interfaces) are the two halves of one surface.
 */

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  ASSET_IDS,
  CHART_RANGES,
  indexName,
  type AssetId,
  type ChartRange,
  type IndexQuality,
  type Market,
} from "@/domain/types";
import {
  fmtGusdPrecise,
  fmtPctSigned,
  fmtStamp,
  fmtUsdPrecise,
  isFlatPct,
} from "@/domain/format";
import { useMarketSnapshot, useMarkets } from "@/data/services";
import { DATA_SOURCE } from "@/data/oracle/config";
import { getOracleFeed } from "@/data/oracle/feed";
import type { CandidateDto } from "@/data/oracle/dto";
import { ORACLE_PANELS } from "@/data/oracle/panel-map";
import { IndexChart } from "@/components/charts/index-chart";
import { IndexStatusChip } from "@/components/ui/index-status-chip";
import { Gusd } from "@/components/ui/pair";
import { TuiPanel } from "@/components/ui/panel";

const RANGES = CHART_RANGES;

/**
 * The interface catalog, status as shipped. LIVE rows are served by the
 * oracle today and consumed by this app; PLANNED rows are not promised.
 */
const CATALOG = [
  { name: "Index feed", method: "REST", status: "live" as const, note: "GET /v1/prices · /v1/prices/:gpu · /history · /candles — candidates and reference series" },
  { name: "Provider panel", method: "REST", status: "live" as const, note: "GET /v1/prices/:gpu/providers — contributors, weights, observation ages" },
  { name: "Stream", method: "SSE", status: "live" as const, note: "GET /v1/stream/sse — candidate publications as they land (WebSocket variant also served)" },
  { name: "Health", method: "REST", status: "live" as const, note: "GET /v1/health — collector breakers, database state" },
  { name: "Market snapshots", method: "REST", status: "prototype" as const, note: "Per-market quote, stats, and candles — the web's data seam; venue fields await a market feed" },
  { name: "History datasets", method: "Download", status: "planned" as const, note: "Candles, index series, provider panels" },
  { name: "Protocol data", method: "RPC", status: "planned" as const, note: "Pools, hooks, issuance state on-chain" },
] as const;

/**
 * Static stand-in for the sample payload, used when the feed has nothing
 * (mock data source, SSR, oracle never reached). Plausible shape, clearly
 * sample values — the real thing replaces it verbatim once a candidate
 * lands.
 */
const SAMPLE_CANDIDATE: CandidateDto = {
  gpuId: "H100_SXM_80GB",
  panelId: "H100_PANEL_V1",
  price: 2.4312,
  confidenceLow: 2.4015,
  confidenceHigh: 2.4609,
  dispersion: 0.018,
  status: "healthy",
  providersObserved: 10,
  providersContributing: 9,
  methodologyVersion: "0.1.0",
  calcHash: "sample00calculatehash0000000000000000000000000000",
  computedAt: "2026-09-04T14:00:00.000Z",
  windowStart: "2026-09-04T13:00:00.000Z",
  windowEnd: "2026-09-04T14:00:00.000Z",
};

/** The feed's latest candidate for one gpu — only in oracle mode; the mock
 *  data source never touches the feed (no connection, no requests). */
function useWireCandidate(gpuId: string): CandidateDto | null {
  const feed = getOracleFeed();
  const subscribe = (cb: () => void) =>
    DATA_SOURCE === "oracle" ? feed.subscribe(cb) : () => {};
  const get = () => (DATA_SOURCE === "oracle" ? (feed.getState().latest[gpuId] ?? null) : null);
  return useSyncExternalStore(subscribe, get, () => null);
}

export default function OraclePage() {
  const markets = useMarkets();
  const [historyAsset, setHistoryAsset] = useState<AssetId>("H100");
  const [historyRange, setHistoryRange] = useState<ChartRange>("15m");
  const history = useMarketSnapshot(historyAsset, historyRange);
  // The wire sample is the H100 panel's latest candidate — the benchmark
  // this board leads with.
  const candidate = useWireCandidate(ORACLE_PANELS.H100.gpuId);
  const payload = candidate ?? SAMPLE_CANDIDATE;
  // Venue columns exist only where a market layer prices the rows (mock
  // universe); in oracle mode the board stays pure reference infrastructure.
  const hasVenue = markets.some((m) => m.marketPrice !== null);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-rule-strong pb-3">
        <h1 className="disp text-[22px] leading-none text-primary">Oracle</h1>
        <p className="slug text-dim">The reference layer · benchmarks · sources · data</p>
      </div>

      {/* 01 — the board: one row per GPU-hour class. Venue columns (market
          price, premium) exist only where a market layer prices the rows —
          infrastructure info, not a second competing price. */}
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
                <IndexBoardRow key={m.asset.id} market={m} hasVenue={hasVenue} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-3.5 pb-3.5 pt-3 text-[11.5px] leading-relaxed text-dim">
          Each benchmark is the weighted reference for its GPU-hour, built from provider
          observations. Before a venue trades it is the one price market surfaces quote; where a
          venue prices the asset separately, the gap between the two prints as a premium or a
          discount.
        </p>
      </TuiPanel>

      {/* 02 — history plate */}
      <div className="mt-5">
        <TuiPanel
          no="02"
          title={
            <>
              <Gusd /> {historyAsset} Index
            </>
          }
          meta="reference series"
          right={
            <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
              <div role="group" aria-label="History benchmark" className="flex items-center">
                {ASSET_IDS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={historyAsset === id}
                    onClick={() => setHistoryAsset(id)}
                    className={`num px-2 py-1 text-[11px] transition-colors ${
                      historyAsset === id ? "text-wire underline decoration-wire underline-offset-4" : "text-dim hover:text-data"
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
                    aria-pressed={historyRange === r}
                    onClick={() => setHistoryRange(r)}
                    className={`num border-b px-2.5 py-1 text-[11px] transition-colors ${
                      historyRange === r ? "border-amber text-amber" : "border-transparent text-dim hover:text-data"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
          }
        >
          {history ? (
            <div className="p-2 pr-3">
              <IndexChart
                points={history.index}
                range={historyRange}
                className="h-72 lg:h-[46vh] lg:min-h-72"
              />
            </div>
          ) : null}
          <div className="border-t border-rule px-3.5 py-2">
            <p className="slug text-dim">The Index alone — market price charts live on each market page</p>
          </div>
        </TuiPanel>
      </div>

      {/* 03 — methodology */}
      <div className="mt-5">
        <TuiPanel no="03" title="Methodology" meta={`methodology ${payload.methodologyVersion}`}>
          <div className="grid gap-6 p-3.5 md:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
            <pre aria-label="Index pipeline diagram" className="num overflow-x-auto text-[10.5px] leading-[1.7] text-data">
{`PROVIDER OBSERVATIONS
  quotes per GPU-hour, USD
          │
          ▼
WEIGHTED PANEL
  fixed weights per class
  stale/delayed sources drop
          │
          ▼
gUSD INDEX  ── published per epoch
          │
          ▼
CONSUMERS
  hooks · market pages · this oracle`}
            </pre>
            <div className="space-y-3 text-[12px] leading-relaxed text-data">
              <p>
                Each GPU class carries a fixed panel of provider observations, normalized to
                USD per GPU-hour. The Index is the weighted reference across those
                observations, republished each oracle epoch.
              </p>
              <p>
                A source that falls behind keeps its place on the Index sources table but its
                influence ages out — the board above shows how many sources are live per
                class right now.
              </p>
              <p className="text-dim">
                Exact weights, epoch cadence, and outlier handling are protocol mechanics
                still being finalized; this page describes the prototype's behavior, not a
                committed specification.
              </p>
            </div>
          </div>
        </TuiPanel>
      </div>

      {/* 04 — panel health */}
      <div className="mt-5">
        <TuiPanel no="04" title="Panel health" meta="ingest quality">
          <dl className="grid grid-cols-2 gap-x-8 p-3.5 md:grid-cols-4">
            <HealthCell
              label="Publication"
              value={history?.quality?.publication ? `#${history.quality.publication}` : "—"}
            />
            <HealthCell label="Updated" value={history?.quality ? fmtStamp(history.quality.updatedAt) : "—"} />
            <HealthCell
              label="Live sources"
              value={history?.quality ? `${history.quality.sourcesLive}/${history.quality.sourcesTotal}` : "—"}
            />
            <HealthCell
              label="Coverage"
              value={
                history?.quality
                  ? history.quality.coveragePct === null
                    ? "—"
                    : `${history.quality.coveragePct.toFixed(0)}%`
                  : "—"
              }
            />
          </dl>
          <p className="px-3.5 pb-3.5 text-[11.5px] leading-relaxed text-dim">
            Per-class provider detail, weights, and observation ages live on each{" "}
            <Link href="/oracle/H100" className="text-data underline decoration-rule-strong underline-offset-2 hover:text-bright">
              benchmark's oracle page
            </Link>
            . The programmatic interfaces are catalogued in 05 below.
          </p>
        </TuiPanel>
      </div>

      {/* 05 — interface catalog */}
      <div className="mt-5">
        <TuiPanel no="05" title="Interface catalog" meta="prototype scope · status as shipped">
          <div className="border-t border-rule">
            {CATALOG.map((row) => (
              <div
                key={row.name}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-rule px-3.5 py-2.5 last:border-b-0"
              >
                <span className="w-44 shrink-0 text-[13px] font-bold text-data">{row.name}</span>
                <span className="num w-24 shrink-0 text-[11px] text-dim">{row.method}</span>
                <span
                  className={`slug border px-1.5 py-0.5 text-[8.5px] ${
                    row.status === "live"
                      ? "border-up text-up"
                      : row.status === "prototype"
                        ? "border-amber text-amber"
                        : "border-rule-strong text-dim"
                  }`}
                >
                  {row.status === "live" ? "LIVE" : row.status === "prototype" ? "PROTOTYPE" : "PLANNED"}
                </span>
                <span className="min-w-0 flex-1 text-[11.5px] text-dim">{row.note}</span>
              </div>
            ))}
          </div>
          <p className="px-3.5 pb-3.5 pt-3 text-[11.5px] leading-relaxed text-dim">
            LIVE rows are served by the oracle today and consumed by this app; PLANNED rows are
            not promised. Market snapshots are built exclusively from this feed in oracle mode —
            the Index is the price; venue figures wait for a market backend. Nothing here invents
            endpoints that don't exist.
          </p>
        </TuiPanel>
      </div>

      {/* 06 — sample payload */}
      <div className="mt-5">
        <TuiPanel no="06" title="Sample payload" meta={`GET /v1/prices/${ORACLE_PANELS.H100.panelId}`}>
          <pre className="num overflow-x-auto border-t border-rule p-3.5 text-[11px] leading-[1.65] text-data">
            {JSON.stringify(payload, null, 2)}
          </pre>
          <p className="px-3.5 pb-3.5 text-[11px] leading-relaxed text-dim">
            {candidate
              ? "The latest published candidate, as served. The same shape arrives over SSE."
              : "Sample candidate shape — the oracle has not published to this session. Connect the oracle to see the live payload here."}
          </p>
        </TuiPanel>
      </div>

      {/* 07 — access */}
      <div className="mt-5">
        <TuiPanel no="07" title="Access" meta="how the product consumes data">
          <div className="space-y-3 p-3.5 text-[12px] leading-relaxed text-data">
            <p>
              The product shell reads everything through a small set of service interfaces —
              market data, trading, minting, earning, auth. Market data is the oracle's live
              feed; the prototype adapters behind trading, minting, earning, and connection
              provide the demo capital and fills — real backends replace them behind identical
              seams.
            </p>
            <p className="text-dim">
              Public endpoints, auth scopes, and rate limits finalize with the protocol
              integrations. Until then the{" "}
              <Link href="/protocol" className="text-data underline decoration-rule-strong underline-offset-2 hover:text-bright">
                protocol page
              </Link>{" "}
              describes the architecture the data flows through.
            </p>
          </div>
        </TuiPanel>
      </div>
    </div>
  );
}

/** One board row; subscribes to the class snapshot for source-quality truth. */
function IndexBoardRow({ market: m, hasVenue }: { market: Market; hasVenue: boolean }) {
  const snapshot = useMarketSnapshot(m.asset.id, "15m");
  const q: IndexQuality | null = snapshot?.quality ?? null;
  const change = m.indexChange24hPct;
  const basis = m.basisPct;

  return (
    <tr className="border-b border-rule last:border-b-0 hover:bg-panel-deep">
      <td className="py-2.5 pl-3.5 pr-4">
        <Link
          href={`/oracle/${m.asset.id}`}
          className="group flex items-baseline gap-2 whitespace-nowrap"
        >
          <span className="num text-[13px] font-bold text-data transition-colors group-hover:text-wire">
            {indexName(m.asset.id)}
          </span>
          <span className="num text-[10px] text-dim transition-colors group-hover:text-data">
            panel ▸
          </span>
          <IndexStatusChip status={m.indexStatus} />
        </Link>
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

function HealthCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-rule py-2">
      <dt className="slug text-dim">{label}</dt>
      <dd className="num mt-1 text-[14px] font-bold text-wire">{value}</dd>
    </div>
  );
}
