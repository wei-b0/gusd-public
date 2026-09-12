/**
 * Overview — what the oracle is and how the number is made. The pipeline,
 * the reasons it can be trusted, and the doctrine that separates a reference
 * price from an execution price. Describes the mechanism, not the wire: this
 * tab reads fully in mock mode.
 */

import { TuiPanel } from "@/components/ui/panel";

export function OverviewTab() {
  return (
    <>
      <p className="max-w-prose mb-5 text-[12.5px] leading-relaxed text-primary">
        The oracle turns fragmented GPU rental-market observations into auditable USD-per-GPU-hour
        benchmarks — one per supported GPU class. Computation is offchain: every candidate carries
        the methodology, provenance, and receipt that produced it, and the public API serves the
        benchmark as data. A separate publisher process independently audits each candidate and
        writes eligible values to the onchain GPUPriceOracle — the external reference price the
        gUSD protocol executes against: hook fills, POL pricing, and primary issuance all read it.
        This tab shows how the number is made; the other tabs let you audit it — the benchmarks it
        publishes, the rules it runs, the health of every layer, and the interfaces it serves.
      </p>

      {/* 01 — the pipeline, stage by stage, with the real parameters */}
      <TuiPanel no="01" title="Pipeline" meta="sources → protocol execution">
        <div className="grid gap-6 p-3.5 md:grid-cols-[minmax(0,540px)_minmax(0,1fr)]">
          <pre
            aria-label="Oracle pipeline diagram"
            className="num overflow-x-auto text-[10.5px] leading-[1.7] text-data"
          >
            {`SOURCES        GPU rental markets · ECB FX · 2 watchdog feeds
  order books · rate cards · price lists
  cadences  FAST 15s · MEDIUM 60s · SLOW 900s
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
GATES          ≥4 providers · ≥3 observations · ≤30 min · disp ≤ 0.45
  fail ⇒ withheld · silent window ⇒ carry forward ≤24h, stale
      │
      ▼
CANDIDATE      oracle verdict · calcHash receipt
  benchmark API + receipt — REST · SSE · WS · this app
      │
      ▼
PUBLISHER      independent audit of every candidate
  violations recorded · publishes on deviation / heartbeat policy
  (~0.5% move or ~24h) · no price ⇒ never published
      │
      ▼
GPUPriceOracle onchain reference price, USD/GPU-hour × 10⁴
      │
      ▼
PROTOCOL       hook fill edges · POL pricing · issuance backstop`}
          </pre>
          <div className="space-y-3 text-[12px] leading-relaxed text-data">
            <p>
              Collectors watch the GPU rental markets on three cadences — order books print
              executable prices, principals publish rate cards — alongside two independent
              watchdog feeds and ECB reference rates. Every observation lands in an append-only
              ledger and is normalized to USD per GPU-hour.
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
              Publication gates decide the oracle's verdict: four providers, three observations
              behind every vote, a 30-minute age ceiling, dispersion within bounds — pass and the
              benchmark publishes with its receipt; fail and it withholds. A silent window
              carries the last figure forward for at most 24 hours, flagged stale.
            </p>
            <p>
              Computation and publication are deliberately separate layers. The candidate — its
              verdict, band, and receipt — exists whether or not anything goes onchain. The
              publisher re-derives each candidate against the stored methodology, records what it
              finds, and publishes when the benchmark has moved ~0.5% from the last published
              value — or a heartbeat (~24 h) refreshes it. Onchain writes are driven by that
              policy, not by every computation.
            </p>
            <p className="text-dim">
              The thresholds on this diagram are the shipped engine defaults, catalogued on the
              Methodology tab; the live source registry — every collector, its role, and its
              cadence — prints there too, served from the oracle itself.
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

      {/* 03 — the doctrine that separates a reference from an execution price */}
      <div className="mt-5">
        <TuiPanel no="03" title="Reference vs execution" meta="doctrine">
          <div className="max-w-prose space-y-3 p-3.5 text-[12px] leading-relaxed text-data">
            <p>
              The benchmark answers one question: what is one GPU-hour of a class worth in the
              underlying compute economy? It is derived from rental-market observations — order
              books, rate cards, price lists — and the protocol's own markets never vote in it.
              The market does not feed back into the benchmark.
            </p>
            <p>
              Onchain execution answers a different question: at what price can this specific
              trade execute? Uniswap-native LP liquidity fills at the pool price up to an
              oracle-anchored edge; demand beyond that edge is filled by the hook itself from POL
              inventory and the issuance backstop, priced off the current oracle reference. One
              swap is the complete market — neither side has to equal the benchmark exactly.
            </p>
            <p>
              Because the hook prices its edges off the oracle, oracle-priced execution moves when
              the oracle moves — it does not wait for AMM ticks to drift toward the new reference.
              A stale oracle degrades gracefully: the hook steps aside and the pool trades
              natively until a fresh publication returns.
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
    body: "Every candidate embeds a receipt — the methodology config, every gate verdict, every contribution and exclusion — and calcHash is its sha256. Re-running the same window over the same inputs reproduces the same bytes: a receipt is a fact, not a claim.",
  },
  {
    label: "Independent audit layer",
    body: "A separate publisher process re-derives each candidate against the stored methodology — freshness, contributors, dispersion, band, source health — and records every violation in its own audit ledger. Publication itself is policy-driven (deviation trigger, heartbeat). The gate is not the calculator grading its own work.",
  },
  {
    label: "Separate layers, on the record",
    body: "Benchmark computation, publisher audit, and onchain publication are separate processes with separate state. The Health tab reports each layer for what it is — a candidate's status is not the publisher's verdict, and neither is the onchain state.",
  },
  {
    label: "Provenance on every figure",
    body: "Every benchmark figure on this site carries the oracle's own verdict — LIVE, STALE, WITHHELD, FROZEN, UNAVAILABLE. The interface never paints a figure healthier than the oracle says it is.",
  },
] as const;
