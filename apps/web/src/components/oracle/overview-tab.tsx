/**
 * Overview — how the oracle makes the number. The pipeline, the reasons it
 * can be trusted, and the doctrine that separates a benchmark from a market.
 * Describes the mechanism, not the wire: this tab reads fully in mock mode.
 */

import { TuiPanel } from "@/components/ui/panel";

export function OverviewTab() {
  return (
    <>
      <p className="max-w-prose mb-5 text-[12.5px] leading-relaxed text-primary">
        Every market on this exchange settles against a benchmark it does not set. The oracle
        observes the GPU compute market, computes one reference price per GPU-hour class, and
        publishes it. This tab shows how the number is made; the other tabs let you audit it —
        the benchmarks it publishes, the rules it runs, the health of its sources, and the
        interfaces it serves.
      </p>

      {/* 01 — the pipeline, stage by stage, with the real parameters */}
      <TuiPanel no="01" title="Pipeline" meta="collector → consumer">
        <div className="grid gap-6 p-3.5 md:grid-cols-[minmax(0,540px)_minmax(0,1fr)]">
          <pre
            aria-label="Oracle pipeline diagram"
            className="num overflow-x-auto text-[10.5px] leading-[1.7] text-data"
          >
{`SOURCES        18 collectors · ECB FX · 2 watchdogs
  order books · rate cards · price lists
  FAST 15s     vast · lium · hyperbolic
  MEDIUM 60s   runpod · shadeform · akash · primeintellect
  SLOW 900s    azure · aws · lambda · coreweave · nebius
               crusoe · scaleway · ovh · oracle-oci
      │
      ▼
INGEST         append-only ledger
  every observation stored with its inputs · nothing rewritten
      │
      ▼
NORMALIZE      units · FX → USD per GPU-hour
  ECB reference rates · monthly ÷ 730 · arithmetic tripwire
      │
      ▼
PANEL          one vote per provider
  depth floors ≥5 machines · ≥3 hosts · median per provider
      │
      ▼
SCREENS        MAD 3σ · jump
  |price − median| > 3σ excluded · ≥25% solo move needs 2 corroborators
      │
      ▼
WEIGHTS        executable 1.0 · rate card 0.6 · cap 0.35
      │
      ▼
AGGREGATE      weighted mean · confidence band
  dispersion = 1.4826 · MAD / median
      │
      ▼
GATES          ≥4 providers · ≤30 min age · dispersion ≤ 0.45
  fail ⇒ withheld · silent window ⇒ carry forward ≤24h, stale
      │
      ▼
PUBLISH        calcHash receipt · independent validation
  movement allowance: printed figure within ±0.05% of the anchor
  byte-reproducible · GPUPriceOracle
      │
      ▼
CONSUME        REST · SSE · this app · on-chain hooks`}
          </pre>
          <div className="space-y-3 text-[12px] leading-relaxed text-data">
            <p>
              Eighteen collectors watch the GPU compute market on three cadences — order books
              print executable prices, principals publish rate cards. Every observation lands in
              an append-only ledger and is normalized to USD per GPU-hour against ECB reference
              rates.
            </p>
            <p>
              The engine screens what arrives: a deviation beyond three robust standard
              deviations from the panel median is excluded, and a solo provider jumping 25%
              needs two corroborators before the move counts. What survives is voted into
              per-provider medians, weighted — executable quotes 1.0, rate cards 0.6, any one
              provider capped at 35% — and aggregated into a weighted mean with a confidence
              band.
            </p>
            <p>
              Publication gates decide the verdict: four providers, three observations, a
              30-minute age ceiling, dispersion within bounds — pass and the figure publishes
              with its receipt; fail and it withholds. A silent window carries the last figure
              forward for at most 24 hours, flagged stale.
            </p>
            <p className="text-dim">
              Every parameter on this diagram is real — the same values the feed runs as
              shipped, catalogued on the Methodology tab.
            </p>
          </div>
        </div>
      </TuiPanel>

      {/* 02 — why the number can be trusted */}
      <div className="mt-5">
        <TuiPanel no="02" title="Why trust it" meta="auditable by construction">
          <div>
            {TRUST_ROWS.map((row) => (
              <div
                key={row.label}
                className="grid gap-x-6 gap-y-1 border-b border-rule px-3.5 py-3 last:border-b-0 md:grid-cols-[190px_minmax(0,1fr)]"
              >
                <span className="slug pt-0.5 text-dim">{row.label}</span>
                <p className="text-[12px] leading-relaxed text-data">{row.body}</p>
              </div>
            ))}
          </div>
        </TuiPanel>
      </div>

      {/* 03 — the doctrine that separates a benchmark from a market */}
      <div className="mt-5">
        <TuiPanel no="03" title="Index ≠ market" meta="doctrine">
          <div className="max-w-prose space-y-3 p-3.5 text-[12px] leading-relaxed text-data">
            <p>
              The Index is the weighted reference for a GPU-hour, not a traded price. Before a
              venue trades the asset it is the one price market surfaces quote; where a venue
              prices the asset separately, the gap between the two prints as a premium or a
              discount — it is never silently absorbed.
            </p>
            <p>
              The Index does not chase the market, and the market does not vote in the Index.
            </p>
            <p className="text-dim">
              The status line repeats the doctrine on every surface of this machine.
            </p>
          </div>
        </TuiPanel>
      </div>
    </>
  );
}

const TRUST_ROWS = [
  {
    label: "Append-only ledger",
    body: "Observations and receipts are stored as they land and never rewritten. History is a ledger, not a document that can be edited — an audit can replay it from the start.",
  },
  {
    label: "Byte-reproducible receipts",
    body: "Every publication embeds a receipt — the methodology config, every gate verdict, every contribution and exclusion — and calcHash is its sha256. Re-running the same window over the same inputs reproduces the same bytes: a receipt is a fact, not a claim.",
  },
  {
    label: "Independent validation",
    body: "A separate publisher process re-derives each candidate before it is accepted for publication and refuses stale or unverified figures. The gate is not the calculator grading its own work.",
  },
  {
    label: "Provenance on every figure",
    body: "Every Index figure on this site carries the oracle's own verdict — LIVE, STALE, WITHHELD, FROZEN, UNAVAILABLE. The interface never paints a figure healthier than the oracle says it is.",
  },
] as const;
