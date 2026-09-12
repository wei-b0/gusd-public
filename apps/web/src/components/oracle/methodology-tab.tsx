/**
 * Methodology — the rules as shipped. The engine's real parameters stage by
 * stage, the provider registry with its roles, and the versioned methodology
 * itself. Panels 01 reads fully in mock mode; 02 and 03 print their wire
 * lines honestly when the oracle is not connected.
 */

import { DATA_SOURCE } from "@/data/oracle/config";
import { ORACLE_PANELS } from "@/data/oracle/panel-map";
import type { ProviderDto } from "@/data/oracle/dto";
import { useWireCandidate, useWireProviders } from "@/components/oracle/use-oracle-feed";
import { TuiPanel } from "@/components/ui/panel";

export function MethodologyTab() {
  return (
    <>
      <p className="max-w-prose mb-5 text-[12.5px] leading-relaxed text-primary">
        These are the rules the oracle runs as shipped — not a summary of intent. Every
        threshold below is the value in the published methodology configuration; a change to
        any of them is a new version, and every receipt records the one that produced it.
      </p>

      {/* 01 — the parameters, stage by stage */}
      <TuiPanel no="01" title="Pipeline stages" meta="v0.2.0 · thresholds live in config, never in code">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-rule-strong text-left">
                <th scope="col" className="slug py-2 pl-3.5 pr-4 text-dim">Stage</th>
                <th scope="col" className="px-2.5 py-2 text-dim">
                  <span className="slug">Rule</span>
                </th>
                <th scope="col" className="slug py-2 pl-2.5 pr-3.5 text-right text-dim">Parameters</th>
              </tr>
            </thead>
            <tbody>
              {STAGE_ROWS.map((row) => (
                <tr key={row.stage} className="border-b border-rule align-top last:border-b-0">
                  <td className="slug py-2.5 pl-3.5 pr-4 whitespace-nowrap text-dim">{row.stage}</td>
                  <td className="max-w-prose px-2.5 py-2.5 text-[12px] leading-relaxed text-data">{row.rule}</td>
                  <td className="num py-2.5 pl-2.5 pr-3.5 text-right whitespace-nowrap text-[11px] text-data">
                    {row.params}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-rule">
          <p className="slug px-3.5 pb-1 pt-2.5 text-dim">Verdicts</p>
          {VERDICT_ROWS.map((row) => (
            <div
              key={row.status}
              className="grid gap-x-6 gap-y-1 border-b border-rule px-3.5 py-2.5 last:border-b-0 md:grid-cols-[120px_minmax(0,1fr)]"
            >
              <span className={`num text-[12px] ${row.tone}`}>{row.status}</span>
              <p className="text-[12px] leading-relaxed text-data">{row.body}</p>
            </div>
          ))}
          <p className="max-w-prose px-3.5 py-3 text-[12px] leading-relaxed text-primary">
            Withheld is safer than fabricated: when the gates fail, the oracle publishes no
            figure rather than a doubtful one, and the interface prints no number rather than
            a wrong one.
          </p>
        </div>
      </TuiPanel>

      {/* 02 — who is collected, and who may vote */}
      <div className="mt-5">
        <TuiPanel no="02" title="Provider registry" meta="GET /v1/providers · read-only">
          <ProviderRegistry />
        </TuiPanel>
      </div>

      {/* 03 — the versioned methodology itself */}
      <div className="mt-5">
        <TuiPanel no="03" title="Methodology version" meta="versioned, never mutated">
          <MethodologyVersion />
        </TuiPanel>
      </div>
    </>
  );
}

const STAGE_ROWS = [
  {
    stage: "Normalize",
    rule: "Units and FX fold into USD per GPU-hour against ECB reference rates (monthly ÷ 730). Rows must add up: a listed total that disagrees with its own per-GPU price is a lie, and is excluded.",
    params: "tol $0.005/GPU · gpus 1–16 · on_demand",
  },
  {
    stage: "Panel",
    rule: "One vote per provider: the median of that provider's observations, taken over a book that clears the depth floors. A thinner book than the floors is not priced.",
    params: "≥5 machines · ≥3 hosts",
  },
  {
    stage: "Screens",
    rule: "Cross-provider MAD screen excludes sources beyond 3 robust σ (σ = 1.4826·MAD) from the panel median; it arms only at 4+ providers, and a zero-MAD tie falls back to a symmetric 3× ratio band. Separately, a provider jumping 25% against its own trailing median is suspect unless 2 others moved 10%+.",
    params: "3σ · band 3× · jump 25% ⇉ 2×10%",
  },
  {
    stage: "Weights",
    rule: "Executable order-book votes weigh 1.0, rate cards 0.6. After aggregation, no single provider may exceed 35% of total weight — no principal owns the number.",
    params: "1.0 / 0.6 · cap 0.35",
  },
  {
    stage: "Aggregate",
    rule: "Weighted mean of the capped weights over the per-provider medians, with a confidence band around it; dispersion is 1.4826·MAD / median. Each contributor's σ enters the band floored at 3% of its price.",
    params: "mean · dispersion · σ floor 0.03",
  },
  {
    stage: "Gates",
    rule: "Publishing requires 4+ providers, 3+ observations behind every vote, observations no older than 30 minutes, executable pricing, and dispersion ≤ 0.45. Any gate failing ⇒ the figure is withheld.",
    params: "4 · 3 · 30 min · ≤0.45",
  },
  {
    stage: "Stale",
    rule: "A window that comes back silent carries the last figure forward — flagged stale, never re-dated — for at most 24 hours. Past that window the figure is withheld.",
    params: "24 h carry-forward",
  },
  {
    stage: "Movement",
    rule: "Publishing allowance (v0.3.0): the printed figure carries a bounded, deterministic, mean-reverting offset within ±0.05% of the computed anchor, so rate-card-settled panels (whose sources are static list prices) still print a moving series. The anchor itself is untouched — screens, band and gates compute on real data — and every publication records its exact offset in the receipt.",
    params: "±0.05% · mean-reverting · recorded",
  },
] as const;

const VERDICT_ROWS = [
  {
    status: "healthy",
    tone: "text-up",
    body: "Full settlement quorum met, dispersion ≤ 0.25. The figure publishes at full confidence.",
  },
  {
    status: "degraded",
    tone: "text-amber",
    body: "Dispersion within 0.45, or the panel computed on a relaxed quorum. It publishes, flagged — never at full confidence.",
  },
  {
    status: "stale",
    tone: "text-amber",
    body: "The window came back silent; the last figure inside 24 h is carried forward, flagged.",
  },
  {
    status: "withheld",
    tone: "text-dim",
    body: "A gate failed, or silence outlasted the carry-forward window. No figure prints.",
  },
] as const;

function ProviderRegistry() {
  const providers = useWireProviders();

  if (providers.length === 0) {
    return (
      <p className="num p-6 text-center text-[11.5px] text-dim">
        {DATA_SOURCE === "oracle"
          ? "Reading the collector registry…"
          : "The collector registry prints when the oracle is connected."}
      </p>
    );
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-rule-strong text-left">
              <th scope="col" className="slug py-2 pl-3.5 pr-4 text-dim">Source</th>
              <th scope="col" className="slug px-2.5 py-2 text-dim">Type</th>
              <th scope="col" className="slug px-2.5 py-2 text-dim">Role</th>
              <th scope="col" className="slug py-2 pr-3.5 text-right text-dim">Cadence</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <RegistryRow key={p.slug} provider={p} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="max-w-prose space-y-2 px-3.5 pb-3.5 pt-3 text-[12px] leading-relaxed">
        <p className="text-data">
          Collection breadth is not settlement eligibility. Only sources marked{" "}
          <span className="num text-data">SETTLEMENT_ELIGIBLE</span> vote on the Index;
          everything else is collected for transparency and cross-checking, and the two
          watchdog feeds are structurally excluded — they exist to contradict the Index, never
          to average into it.
        </p>
        <p className="text-dim">
          Cadence tiers: FAST polls every 15 s, MEDIUM every 60 s, SLOW every 900 s. The FX
          feed (ECB reference rates) runs alongside this registry and is listed on the
          Overview pipeline.
        </p>
      </div>
    </div>
  );
}

function RegistryRow({ provider: p }: { provider: ProviderDto }) {
  const settlement = p.role === "SETTLEMENT_ELIGIBLE";
  const watchdog = p.role === "WATCHDOG_ONLY";

  return (
    <tr className="border-b border-rule last:border-b-0">
      <td className={`py-2 pl-3.5 pr-4 text-[12.5px] ${watchdog ? "text-dim" : "text-data"}`}>
        {p.name}
      </td>
      <td className="num px-2.5 py-2 text-[11px] text-data">{p.sourceType}</td>
      <td className={`num px-2.5 py-2 text-[11px] ${settlement ? "text-data" : "text-dim"}`}>
        {p.role}
      </td>
      <td className="num py-2 pr-3.5 text-right text-[11px] text-dim">{p.cadenceTier}</td>
    </tr>
  );
}

function MethodologyVersion() {
  // One candidate is enough — every panel in a window publishes under the
  // same methodology version. H100 is the flagship panel and publishes first.
  const candidate = useWireCandidate(ORACLE_PANELS.H100?.gpuId ?? "");
  const version = candidate?.methodologyVersion ?? null;

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3.5 pb-3 pt-3">
        <span className="slug text-dim">Live version</span>
        <span className="num text-[15px] font-bold text-bright">{version ?? "—"}</span>
        {candidate && (
          <span className="num text-[10px] text-dim">
            as computed by #{candidate.calcHash.slice(0, 7)}
          </span>
        )}
        {!candidate && (
          <span className="num text-[10px] text-dim">
            {DATA_SOURCE === "oracle"
              ? "the version prints with the first publication"
              : "the live version prints when the oracle is connected"}
          </span>
        )}
      </div>
      <div className="max-w-prose space-y-3 px-3.5 pb-3.5 text-[12px] leading-relaxed text-data">
        <p>
          The methodology is a configuration, not code paths: thresholds live in a validated
          config that is versioned and stored with every receipt. There is no hot-editing — a
          methodology change is a new config under a new version, checked field by field
          before it can drive a computation, and a config that half-matches fails loudly
          rather than partially applying.
        </p>
        <p>
          v0.4.0 settles the launch four: H100 and H200 keep the full executable quorum, while
          L40S and RTX 4090 cannot reach it on order books alone — L40S settles on a reduced
          panel over named rate-card principals (no executable floor for now), and RTX 4090
          promotes Akash alongside its executable venues. The override may only ever
          relax a gate, and the engine caps any panel that computes below the full settlement
          quorum at <span className="num text-amber">degraded</span>: a relaxed panel can
          never claim <span className="num text-up">healthy</span>.
        </p>
        <p className="text-dim">
          Every figure this site prints carries the methodologyVersion that produced it, on
          the wire and in the receipts. Older receipts stay readable against the version that
          made them — history is never re-interpreted under new rules.
        </p>
      </div>
    </div>
  );
}
