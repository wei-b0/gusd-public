/**
 * Developers — the oracle as a data product. The interface catalog (nothing
 * invented), the endpoint reference with a live payload, code samples against
 * this deployment's base URL, the stream's exact semantics, the candles'
 * contract, and access. Wire truth throughout: every path listed here is
 * served by apps/oracle as shipped.
 */

import Link from "next/link";
import { DATA_SOURCE, ORACLE_BASE_URL } from "@/data/oracle/config";
import { ORACLE_PANELS } from "@/data/oracle/panel-map";
import { SAMPLE_CANDIDATE } from "@/components/oracle/sample-candidate";
import { useWireCandidate } from "@/components/oracle/use-oracle-feed";
import { CodeBlock } from "@/components/oracle/code-block";
import { TuiPanel } from "@/components/ui/panel";

/** The interface catalog, status as shipped — the server's route table,
 *  verbatim. LIVE rows are served today and consumed by this app; PLANNED
 *  rows are not promised. */
const CATALOG = [
  { name: "Latest candidates", method: "REST", status: "live" as const, note: "GET /v1/prices — the newest published candidate for every settlement panel" },
  { name: "Candidate", method: "REST", status: "live" as const, note: "GET /v1/prices/:gpu — one panel's latest; accepts the panel id or the gpu id; 404 means none was ever computed" },
  { name: "Candidate history", method: "REST", status: "live" as const, note: "GET /v1/prices/:gpu/history?limit — recent publications, default 100, clamped to 500, served oldest-first" },
  { name: "Reference candles", method: "REST", status: "live" as const, note: "GET /v1/prices/:gpu/candles — server-bucketed OHLC over the canonical benchmark series" },
  { name: "Panel receipt", method: "REST", status: "live" as const, note: "GET /v1/prices/:gpu/providers — the contributors, weights, and screens behind the latest candidate" },
  { name: "Provider registry", method: "REST", status: "live" as const, note: "GET /v1/providers — sources, roles, cadence tiers; metadata only, no prices" },
  { name: "Health", method: "REST", status: "live" as const, note: "GET /v1/health — collector breakers and database state; a 503 body is data, not an error" },
  { name: "Stream", method: "SSE", status: "live" as const, note: "GET /v1/stream/sse — event: candidate frames as publications land" },
  { name: "Stream", method: "WS", status: "live" as const, note: "GET /v1/stream — the same candidates as WebSocket text frames, envelope-wrapped" },
  { name: "Market snapshots", method: "REST", status: "prototype" as const, note: "Per-market quote, stats, and candles — the web's data seam; venue fields await a market feed" },
  { name: "History datasets", method: "Download", status: "planned" as const, note: "Bulk candles, index series, provider panels" },
  { name: "Protocol data", method: "RPC", status: "planned" as const, note: "Pools, hooks, issuance state on-chain" },
] as const;

const PARAM_ROWS = [
  { param: ":gpu", routes: "all /v1/prices/:gpu/*", note: "panel id (H100_PANEL_V1) or gpu id (H100_SXM_80GB); anything else is a 404" },
  { param: "limit", routes: "history", note: "1–500 candidates, default 100" },
  { param: "intervalSec", routes: "candles", note: "one of 60 · 300 · 900 · 1800 · 3600 · 14400 · 21600 · 43200 · 86400 · 604800 (seconds)" },
  { param: "from · to", routes: "candles", note: "epoch ms or ISO instants; absent → trailing 24 h; a window may span at most 2000 buckets" },
] as const;

export function DevelopersTab() {
  // The wire sample is the H100 panel's latest candidate.
  const candidate = useWireCandidate(ORACLE_PANELS.H100?.gpuId ?? "");
  const payload = candidate ?? SAMPLE_CANDIDATE;

  return (
    <>
      <p className="max-w-prose mb-5 text-[12.5px] leading-relaxed text-primary">
        The oracle is a data product, and this tab is its manual. Every endpoint below is
        served today and consumed by this site — there is no private path the app keeps for
        itself. Point a client at the base URL and read the benchmarks.
      </p>

      {/* 01 — what exists, and only what exists */}
      <TuiPanel no="01" title="Interface catalog" meta="status as shipped">
        <div className="border-t border-rule">
          {CATALOG.map((row, i) => (
            <div
              key={`${row.name}-${row.method}-${i}`}
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
          LIVE rows are served by the oracle today; PROTOTYPE rows are wired but await a
          market feed for their venue fields; PLANNED rows are not promised. Nothing here
          invents endpoints that don't exist.
        </p>
      </TuiPanel>

      {/* 02 — the candidate object, shape and as served */}
      <div className="mt-5">
        <TuiPanel no="02" title="Endpoint reference" meta="the candidate is the unit">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-rule-strong text-left">
                  <th scope="col" className="slug py-2 pl-3.5 pr-4 font-normal text-dim">Parameter</th>
                  <th scope="col" className="slug px-2.5 py-2 font-normal text-dim">Routes</th>
                  <th scope="col" className="px-2.5 py-2 pr-3.5 font-normal text-dim">
                    <span className="slug">Meaning</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {PARAM_ROWS.map((row) => (
                  <tr key={row.param} className="border-b border-rule last:border-b-0">
                    <td className="num py-2 pl-3.5 pr-4 whitespace-nowrap text-data">{row.param}</td>
                    <td className="num px-2.5 py-2 text-[11px] text-dim">{row.routes}</td>
                    <td className="px-2.5 py-2 pr-3.5 text-[11.5px] leading-relaxed text-data">{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-px border-t border-rule bg-rule md:grid-cols-2">
            <div className="bg-panel">
              <p className="slug border-b border-rule px-3.5 py-2 text-dim">Shape</p>
              <pre className="num overflow-x-auto p-3.5 text-[10.5px] leading-[1.65] text-data">
{`{
  gpuId: "H100_SXM_80GB",
  panelId: "H100_PANEL_V1",
  price: 2.4312,          // USD / GPU-hour · null when withheld
  confidenceLow: 2.4015,  // the confidence band
  confidenceHigh: 2.4609,
  dispersion: 0.018,      // 1.4826·MAD / median
  status: "healthy",      // healthy · degraded · stale · withheld
  providersObserved: 10,  // panel size this window
  providersContributing: 9, // votes that survived the screens
  methodologyVersion: "0.2.0",
  calcHash: "3f9c1ab…",   // sha256 receipt — the publication's identity
  computedAt: "2026-09-04T14:00:00.000Z",
  windowStart: "2026-09-04T13:00:00.000Z",
  windowEnd: "2026-09-04T14:00:00.000Z"
}`}
              </pre>
            </div>
            <div className="bg-panel">
              <p className="slug border-b border-rule px-3.5 py-2 text-dim">
                As served — GET /v1/prices/{ORACLE_PANELS.H100?.panelId ?? "H100_PANEL_V1"}
              </p>
              <pre className="num overflow-x-auto p-3.5 text-[10.5px] leading-[1.65] text-data">
                {JSON.stringify(payload, null, 2)}
              </pre>
            </div>
          </div>
          <p className="px-3.5 pb-3.5 pt-2.5 text-[11px] leading-relaxed text-dim">
            {candidate
              ? "The latest published candidate, as served. The same shape arrives over the stream."
              : "Sample candidate shape — the oracle has not published to this session. Connect the oracle to see the live payload here."}
          </p>
        </TuiPanel>
      </div>

      {/* 03 — working samples against this deployment */}
      <div className="mt-5">
        <TuiPanel no="03" title="Code samples" meta={ORACLE_BASE_URL}>
          <div className="space-y-px bg-rule">
            <div className="bg-panel">
              <CodeBlock label="curl" code={CURL_SAMPLE} />
            </div>
            <div className="bg-panel">
              <CodeBlock label="typescript" code={TS_SAMPLE} />
            </div>
            <div className="bg-panel">
              <CodeBlock label="python" code={PY_SAMPLE} />
            </div>
          </div>
          <p className="px-3.5 pb-3.5 pt-2.5 text-[11px] leading-relaxed text-dim">
            All endpoints are plain GETs, CORS is open, and there are no keys. The base URL
            shown is this deployment's — set <span className="num">NEXT_PUBLIC_ORACLE_URL</span>{" "}
            to point the samples elsewhere.
          </p>
        </TuiPanel>
      </div>

      {/* 04 — the stream's exact semantics */}
      <div className="mt-5">
        <TuiPanel no="04" title="Streaming" meta="SSE · WebSocket">
          <div className="grid gap-6 p-3.5 md:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
            <pre aria-label="SSE wire excerpt" className="num overflow-x-auto text-[10.5px] leading-[1.7] text-data">
{`: connected
: ping
event: candidate
data: {"gpuId":"H100_SXM_80GB",
       "price":2.4312,
       "status":"healthy", …}`}
            </pre>
            <div className="space-y-3 text-[12px] leading-relaxed text-data">
              <p>
                Frames are <span className="num">event: candidate</span> with the candidate JSON as
                data — the same shape as GET /v1/prices/:gpu. After connecting the server writes{" "}
                <span className="num">: connected</span>, then <span className="num">: ping</span>{" "}
                every 15 seconds; the ping proves the transport, not the data.
              </p>
              <p>
                Candidates publish as computed, debounced at least 10 seconds apart per panel —
                silence usually means nothing changed, not that the stream died.
              </p>
              <p>
                The stream is lossy by design: a highlight reel, not a record. Treat REST as the
                truth — on open, re-read GET /v1/prices before trusting the frames you missed.
                The client that powers this site does exactly that.
              </p>
              <p className="text-dim">
                A WebSocket variant serves the same candidates at GET /v1/stream, wrapped as text
                frames: <span className="num">{`{"type":"candidate","candidate":{…}}`}</span>.
              </p>
            </div>
          </div>
        </TuiPanel>
      </div>

      {/* 05 — the candles contract */}
      <div className="mt-5">
        <TuiPanel no="05" title="Historical data" meta="GET /v1/prices/:gpu/candles">
          <div>
            {HISTORY_ROWS.map((row) => (
              <div
                key={row.label}
                className="grid gap-x-6 gap-y-1 border-b border-rule px-3.5 py-3 last:border-b-0 md:grid-cols-[150px_minmax(0,1fr)]"
              >
                <span className="slug pt-0.5 text-dim">{row.label}</span>
                <p className="text-[12px] leading-relaxed text-data">{row.body}</p>
              </div>
            ))}
          </div>
        </TuiPanel>
      </div>

      {/* 06 — access */}
      <div className="mt-5">
        <TuiPanel no="06" title="Access" meta="open by construction">
          <div className="max-w-prose space-y-3 p-3.5 text-[12px] leading-relaxed text-data">
            <p>
              Every endpoint on this tab is open today — plain GETs, CORS open, no keys, no
              account. There is no separate public tier to opt into: the feed that serves you
              is the feed this site runs on.
            </p>
            <p className="text-dim">
              Tiered access (higher limits, deeper history, SLAs) finalizes with the protocol
              integrations. Until then the{" "}
              <Link
                href="/protocol"
                className="text-data underline decoration-rule-strong underline-offset-2 hover:text-bright"
              >
                protocol page
              </Link>{" "}
              describes the architecture the data flows through.
            </p>
          </div>
        </TuiPanel>
      </div>
    </>
  );
}

const HISTORY_ROWS = [
  {
    label: "Intervals",
    body: "intervalSec ∈ 60 300 900 1800 3600 14400 21600 43200 86400 604800 — one minute to one week. Each bucket aggregates the computed benchmarks that landed within it.",
  },
  {
    label: "Window · order",
    body: "from/to take epoch ms or ISO instants; absent, the trailing 24 hours. A window may span at most 2000 buckets. Buckets return oldest-first on a regular grid, ready for arithmetic on t.",
  },
  {
    label: "Silence",
    body: "A silent interval comes back as a carried bucket — o = h = l = c = previous close, samples 0, carried: true. It asserts that nothing new landed, never a level: skip it or flatten it, but never read it as a price.",
  },
  {
    label: "What it is",
    body: "The benchmark's own history — every gated computation aggregated per interval. Observations, not trades; trade OHLCV arrives with the market layer.",
  },
] as const;

const CURL_SAMPLE = `BASE=${ORACLE_BASE_URL}

# latest candidate for one settlement panel (panel id or gpu id)
curl $BASE/v1/prices/H100_PANEL_V1

# the panel receipt behind it — contributors, weights, screens
curl $BASE/v1/prices/H100_PANEL_V1/providers

# 1-hour reference candles for the trailing week (epoch ms)
curl "$BASE/v1/prices/H100_PANEL_V1/candles?intervalSec=3600&from=$(($(date +%s)000-604800000))&to=$(date +%s)000"

# live publications
curl -N $BASE/v1/stream/sse`;

const TS_SAMPLE = `const BASE = "${ORACLE_BASE_URL}";

type Candidate = {
  gpuId: string;
  price: number | null;      // USD / GPU-hour
  status: string;            // healthy · degraded · stale · withheld
  calcHash: string;          // receipt identity
  methodologyVersion: string;
};

// one-shot read — plain GET, CORS open, no keys
const res = await fetch(\`\${BASE}/v1/prices/H100_PANEL_V1\`);
const candidate = (await res.json()) as Candidate;

// live publications
const stream = new EventSource(\`\${BASE}/v1/stream/sse\`);
stream.addEventListener("candidate", (e) => {
  const c = JSON.parse((e as MessageEvent<string>).data) as Candidate;
});
stream.onopen = async () => {
  // the stream is lossy — REST is the truth; sync on open
  await fetch(\`\${BASE}/v1/prices\`);
};`;

const PY_SAMPLE = `import json, requests, sseclient

BASE = "${ORACLE_BASE_URL}"

# one-shot read
candidate = requests.get(f"{BASE}/v1/prices/H100_PANEL_V1", timeout=5).json()

# live publications — re-read REST on connect; the stream is lossy
stream = requests.get(f"{BASE}/v1/stream/sse", stream=True, timeout=None)
for event in sseclient.SSEClient(stream).events():
    if event.event == "candidate":
        candidate = json.loads(event.data)`;
