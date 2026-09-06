/**
 * Health — the oracle reporting itself. Publication identity and source
 * counts from the feed's latest candidates, the collector registry's breakers
 * from GET /v1/health, and per-panel freshness. Every figure here is the
 * oracle's own verdict; the page renders it without softening.
 */

import { ASSET_IDS, indexName, type AssetId } from "@/domain/types";
import { fmtAge, fmtStamp } from "@/domain/format";
import { DATA_SOURCE } from "@/data/oracle/config";
import { ORACLE_PANELS } from "@/data/oracle/panel-map";
import { mapIndexStatus } from "@/data/oracle/map";
import type { CandidateDto, CollectorHealthDto } from "@/data/oracle/dto";
import {
  useNowTick,
  useWireConnection,
  useWireHealth,
  useWireLatest,
  useWireProviders,
} from "@/components/oracle/use-oracle-feed";
import { IndexStatusChip } from "@/components/ui/index-status-chip";
import { TuiPanel } from "@/components/ui/panel";

export function HealthTab() {
  return (
    <>
      <p className="max-w-prose mb-5 text-[12.5px] leading-relaxed text-primary">
        The oracle reporting itself — not a dashboard's opinion of the oracle. Publication
        identity, source counts, collector breakers, and per-panel freshness all come off the
        same wire the benchmarks do, refreshed every minute.
      </p>

      {/* 01 — publication status, from the latest candidates */}
      <TuiPanel no="01" title="Publication status" meta="GET /v1/prices · /v1/health">
        <PublicationStatus />
      </TuiPanel>

      {/* 02 — collector breakers */}
      <div className="mt-5">
        <TuiPanel no="02" title="Collector health" meta="GET /v1/health · per-collector breakers">
          <CollectorHealth />
        </TuiPanel>
      </div>

      {/* 03 — per-panel freshness */}
      <div className="mt-5">
        <TuiPanel no="03" title="Panel freshness" meta="the oracle's own verdict">
          <PanelFreshness />
        </TuiPanel>
      </div>
    </>
  );
}

function HealthCell({ label, value, tone = "text-wire" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="border-b border-rule py-2">
      <dt className="slug text-dim">{label}</dt>
      <dd className={`num mt-1 text-[14px] font-bold ${tone}`}>{value}</dd>
    </div>
  );
}

function PublicationStatus() {
  const latest = useWireLatest();
  const health = useWireHealth();
  const connection = useWireConnection();
  const now = useNowTick(30_000);

  const candidates = Object.values(latest);
  // The most recent publication across the panels — its receipt hash and
  // stamp stand for the feed's last word.
  let newest: CandidateDto | null = null;
  let contributing = 0;
  let observed = 0;
  for (const c of candidates) {
    const t = safeParse(c.computedAt);
    if (t !== null && (newest === null || t > (safeParse(newest.computedAt) ?? 0))) newest = c;
    contributing += c.providersContributing;
    observed += c.providersObserved;
  }

  const overall =
    connection === "down"
      ? { value: "UNREACHABLE", tone: "text-amber" }
      : health !== null
        ? {
            value: health.status.toUpperCase(),
            tone: health.status === "healthy" ? "text-up" : "text-amber",
          }
        : { value: "—", tone: "text-wire" };

  return (
    <div>
      <dl className="grid grid-cols-2 gap-x-8 p-3.5 md:grid-cols-5">
        <HealthCell label="Publication" value={newest ? `#${newest.calcHash.slice(0, 7)}` : "—"} />
        <HealthCell label="Updated" value={newest ? fmtStamp(safeParse(newest.computedAt) ?? 0) : "—"} />
        <HealthCell
          label="Live sources"
          value={candidates.length > 0 ? `${contributing}/${observed}` : "—"}
        />
        <HealthCell label="Overall" value={overall.value} tone={overall.tone} />
        <HealthCell
          label="Database"
          value={health === null ? "—" : health.db ? "UP" : "DOWN"}
          tone={health !== null && !health.db ? "text-amber" : "text-wire"}
        />
      </dl>
      <p className="px-3.5 pb-3.5 text-[11.5px] leading-relaxed text-dim">
        {candidates.length > 0
          ? `Source counts sum the panels' latest publications — a provider observing several classes is counted per class. A 503 from GET /v1/health is data, not an error: the oracle reporting a database outage.`
          : DATA_SOURCE === "oracle"
            ? "No publication has reached this session yet — the cells fill with the first candidate."
            : "The oracle's health document prints when the oracle is connected."}
      </p>
    </div>
  );
}

function CollectorHealth() {
  const health = useWireHealth();
  const providers = useWireProviders();
  const now = useNowTick();

  const names = new Map(providers.map((p) => [p.slug, p.name]));
  const rows = health?.collectors ?? [];

  if (health === null) {
    return (
      <p className="num p-6 text-center text-[11.5px] text-dim">
        {DATA_SOURCE === "oracle"
          ? "Reading collector health…"
          : "Collector health prints when the oracle is connected."}
      </p>
    );
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-rule-strong text-left">
              <th scope="col" className="slug py-2 pl-3.5 pr-4 text-dim">Collector</th>
              <th scope="col" className="slug px-2.5 py-2 text-dim">Breaker</th>
              <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Last success</th>
              <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Last failure</th>
              <th scope="col" className="slug py-2 pr-3.5 text-right text-dim">Consecutive</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <CollectorRow key={row.collectorId} row={row} name={names.get(row.providerSlug) ?? row.providerSlug} now={now} />
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <p className="num p-4 text-center text-[11.5px] text-dim">The oracle reports no collectors.</p>
      )}
      <p className="px-3.5 pb-3.5 pt-3 text-[11.5px] leading-relaxed text-dim">
        A breaker opens after repeated failures and takes the collector out of rotation until
        it recovers — the source stops voting, it is never guessed for. Watchdog feeds appear
        here too: their health matters even though their prices never settle.
      </p>
    </div>
  );
}

function CollectorRow({ row, name, now }: { row: CollectorHealthDto; name: string; now: number | null }) {
  const success = safeParse(row.lastSuccessAt);
  const failure = safeParse(row.lastFailureAt);
  const stamp = (t: number | null) => (t === null ? "—" : now === null ? fmtStamp(t) : fmtAge(t, now));

  return (
    <tr className={`border-b border-rule last:border-b-0 ${row.breakerOpen ? "hatch" : ""}`}>
      <td className="py-2.5 pl-3.5 pr-4">
        <span className="flex items-center gap-2 whitespace-nowrap">
          <span
            role="img"
            aria-label={row.breakerOpen ? "breaker open" : "healthy"}
            className={`num text-[9px] leading-none ${row.breakerOpen ? "text-amber" : "text-up"}`}
          >
            {row.breakerOpen ? "◐" : "●"}
          </span>
          <span className="text-[12.5px] text-data">{name}</span>
          {row.breakerOpen && <span className="slug text-amber">BREAKER OPEN</span>}
        </span>
      </td>
      <td className="num px-2.5 py-2.5 text-[11px]">
        {row.breakerOpen ? (
          <span className="text-amber">
            open{row.breakerOpenedAt !== null && now !== null && safeParse(row.breakerOpenedAt) !== null
              ? ` ${fmtAge(safeParse(row.breakerOpenedAt)!, now)}`
              : ""}
          </span>
        ) : (
          <span className="text-dim">closed</span>
        )}
      </td>
      <td className="num px-2.5 py-2.5 text-right text-[11px] text-data">{stamp(success)}</td>
      <td className="num px-2.5 py-2.5 text-right text-[11px]">
        {failure === null ? (
          <span className="text-dim">—</span>
        ) : (
          <span className="text-amber">
            {row.lastFailureKind ?? "error"}
            <span className="text-dim"> · {stamp(failure)}</span>
          </span>
        )}
      </td>
      <td className={`num py-2.5 pr-3.5 text-right ${row.consecutiveFailures > 0 ? "text-amber" : "text-dim"}`}>
        {row.consecutiveFailures}
      </td>
    </tr>
  );
}

function PanelFreshness() {
  const latest = useWireLatest();
  const now = useNowTick();
  const t = now ?? Date.now();
  const assets = ASSET_IDS.filter((id) => id in ORACLE_PANELS);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-rule-strong text-left">
              <th scope="col" className="slug py-2 pl-3.5 pr-4 text-dim">Panel</th>
              <th scope="col" className="slug px-2.5 py-2 text-dim">Status</th>
              <th scope="col" className="slug py-2 pr-3.5 text-right text-dim">Last publication</th>
            </tr>
          </thead>
          <tbody>
            {assets.map((asset) => {
              const candidate = latest[ORACLE_PANELS[asset]!.gpuId] ?? null;
              return (
                <tr key={asset} className="border-b border-rule last:border-b-0">
                  <td className="num py-2.5 pl-3.5 pr-4 text-[13px] font-bold text-data">
                    {indexName(asset)}
                  </td>
                  <td className="px-2.5 py-2.5">
                    {candidate ? (
                      <IndexStatusChip status={mapIndexStatus(candidate, t)} />
                    ) : (
                      <span className="num text-[11px] text-dim">—</span>
                    )}
                  </td>
                  <td className="num py-2.5 pr-3.5 text-right text-[11px] text-dim">
                    {candidate === null
                      ? "—"
                      : now === null
                        ? fmtStamp(safeParse(candidate.computedAt) ?? 0)
                        : fmtAge(safeParse(candidate.computedAt) ?? 0, now)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="max-w-prose px-3.5 pb-3.5 pt-3 text-[11.5px] leading-relaxed text-dim">
        Freshness is the oracle's own verdict, not the page's: LIVE sits inside the
        publisher's age gate, STALE inside the carry-forward window, WITHHELD when the gates
        refused to assert a price. A dash means no publication has reached this session.
      </p>
    </div>
  );
}

/** Date.parse that never invents a timestamp for malformed or absent wire
 *  input — a null stamp parses to null, never to an epoch. */
function safeParse(iso: string | null): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}
