#!/usr/bin/env node
/**
 * Mock oracle — a wire-faithful fixture server for web development and
 * visual verification. Speaks the exact oracle API the web consumes (see
 * apps/oracle/src/server.ts and apps/web/src/data/oracle/dto.ts):
 *
 *   GET /v1/prices                          → { prices: CandidateDto[] }
 *   GET /v1/prices/:gpu                     → CandidateDto | 404
 *   GET /v1/prices/:gpu/history?limit=n     → { history: CandidateDto[] } (newest-first)
 *   GET /v1/prices/:gpu/candles             → CandlesResponse (server-bucketed OHLC)
 *   GET /v1/prices/:gpu/providers           → PanelProvidersDto | 404
 *   GET /v1/providers                       → { providers: ProviderDto[] }
 *   GET /v1/health                          → health document (503 body is data)
 *   GET /v1/stream/sse                      → SSE (`: connected`, `: ping`, `event: candidate`)
 *
 * Zero dependencies (node:http only), port 8081 by default. Start it and run
 * the web app with NEXT_PUBLIC_ORACLE_URL=http://127.0.0.1:8081.
 *
 * Flags:
 *   --status=healthy|degraded|withheld|frozen   candidate status (default healthy)
 *   --health=unhealthy                          health reports a DB outage (503 + body)
 *   --flap                                      close SSE connections every 45s (reconnect drill)
 *   --sparse                                    ~40-point history instead of ~500
 *   --all-live                                  all 10 sources contribute, no exclusions —
 *                                               the panel shape behind the green lamp
 *   --deterministic                             seeded price walk, no random drift —
 *                                               stable values for rasters
 *
 * Usage: pnpm web:fixture [--flags]   (or: node apps/web/scripts/mock-oracle.mjs)
 */

import { createHash, randomUUID } from "node:crypto";
import http from "node:http";

const args = new Set(process.argv.slice(2));
const flagValue = (name) => {
  const arg = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split("=")[1] : undefined;
};

const PORT = Number(flagValue("port") ?? 8081);
const STATUS = flagValue("status") ?? "healthy";
const UNHEALTHY = args.has("--health-unhealthy") || flagValue("health") === "unhealthy";
const FLAP = args.has("--flap");
const SPARSE = args.has("--sparse");
const DETERMINISTIC = args.has("--deterministic");
// All ten sources contribute and nothing is excluded — the one panel shape
// that turns the status-line lamp green (green requires every observed
// source contributing).
const ALL_LIVE = args.has("--all-live");

const PUBLISH_MS = 20_000; // engine debounce is ≥10s/GPU; 20s is a sane fixture cadence
const HISTORY_LIMIT = SPARSE ? 40 : 500;
const FLAP_MS = 45_000;
const PING_MS = 15_000;

/** Price anchors, USD per GPU-hour — the full settlement-panel set, aligned
 *  with the web's mock universe (mock-oracle mirrors INDEX_ANCHOR ± 0.1%) so
 *  premiums/discounts land in familiar territory. Panel ids mirror
 *  packages/gpu-catalog SETTLEMENT_PANELS. */
const PANELS = {
  A100_PANEL_V1: { gpuId: "A100_SXM_80GB", anchor: 1.4092 },
  H100_PANEL_V1: { gpuId: "H100_SXM_80GB", anchor: 2.4312 },
  H200_PANEL_V1: { gpuId: "H200_141GB", anchor: 2.9784 },
  B200_PANEL_V1: { gpuId: "B200_192GB", anchor: 4.4156 },
  B300_PANEL_V1: { gpuId: "B300_288GB", anchor: 5.6072 },
  GB200_PANEL_V1: { gpuId: "GB200_192GB", anchor: 6.3068 },
  GB300_PANEL_V1: { gpuId: "GB300_288GB", anchor: 7.5238 },
};

/** Provider registry — the same panel the product's mock universe names. */
const PROVIDERS = [
  ["vantage", "Vantage Compute", "spot-auction", "primary", "sub-hour"],
  ["tensorspot", "TensorSpot", "spot-auction", "primary", "sub-hour"],
  ["gridcarry", "Gridcarry", "rental-book", "primary", "hourly"],
  ["helion-pool", "Helion Pool", "aggregator", "supporting", "hourly"],
  ["baselayer", "Baselayer", "rental-book", "primary", "hourly"],
  ["opstation", "Opstation", "rental-book", "primary", "hourly"],
  ["cumulus-nodes", "Cumulus Nodes", "aggregator", "supporting", "daily"],
  ["tallgrass", "Tallgrass Compute", "rental-book", "supporting", "hourly"],
  ["parsec-rentals", "Parsec Rentals", "aggregator", "supporting", "daily"],
  ["meridian-fleet", "Meridian Fleet", "direct-fleet", "supporting", "daily"],
].map(([slug, name, sourceType, role, cadenceTier]) => ({
  slug,
  name,
  sourceType,
  role,
  cadenceTier,
  homepageUrl: null,
  config: {},
}));

const PROVIDER_WEIGHTS = {
  vantage: 18, tensorspot: 16, gridcarry: 15, "helion-pool": 13, baselayer: 12,
  opstation: 11, "cumulus-nodes": 9, tallgrass: 8, "parsec-rentals": 7, "meridian-fleet": 8,
};

// -- deterministic noise -----------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Price for one panel at one publish tick. Deterministic mode uses a seeded
 *  walk over the tick index; otherwise a gentle random drift. */
function priceAt(panelId, tick) {
  const { gpuId, anchor } = PANELS[panelId];
  if (DETERMINISTIC) {
    const noise = mulberry32(hashSeed(`${gpuId}:${tick}`))() - 0.5;
    return round4(anchor * (1 + noise * 0.001));
  }
  const noise = (Math.random() - 0.5) * 0.001;
  return round4(anchor * (1 + noise));
}

function round4(n) {
  return Math.round(n * 10_000) / 10_000;
}

// -- candidates ---------------------------------------------------------------

const currentTick = () => Math.floor(Date.now() / PUBLISH_MS);

function candidateAt(panelId, tick) {
  const { gpuId } = PANELS[panelId];
  const computedAt = new Date(tick * PUBLISH_MS).toISOString();
  const withheld = STATUS === "withheld" || STATUS === "frozen";
  const price = withheld ? null : priceAt(panelId, tick);
  const noise = DETERMINISTIC ? mulberry32(hashSeed(`conf:${gpuId}:${tick}`)) : Math.random;
  return {
    gpuId,
    panelId,
    price,
    confidenceLow: price === null ? null : round4(price * (1 - 0.006 - noise() * 0.004)),
    confidenceHigh: price === null ? null : round4(price * (1 + 0.006 + noise() * 0.004)),
    dispersion: round4(0.012 + noise() * 0.012),
    status: STATUS,
    providersObserved: PROVIDERS.length,
    providersContributing: withheld ? 0 : ALL_LIVE ? PROVIDERS.length : 9,
    methodologyVersion: "0.1.0",
    calcHash: createHash("sha256").update(`${gpuId}:${tick}:${price ?? STATUS}`).digest("hex"),
    computedAt,
    windowStart: new Date(tick * PUBLISH_MS - 5 * 60_000).toISOString(),
    windowEnd: computedAt,
  };
}

const latestCandidate = (panelId) => candidateAt(panelId, currentTick());

/** History, NEWEST-FIRST like the real endpoint. */
function historyFor(panelId, limit) {
  const n = Math.min(Math.max(1, limit), 500);
  const tick = currentTick();
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(candidateAt(panelId, tick - i));
  return rows;
}

/** Contributor panel behind the latest candidate. */
function panelProviders(panelId) {
  const { gpuId, anchor } = PANELS[panelId];
  const candidate = latestCandidate(panelId);
  const rand = DETERMINISTIC ? mulberry32(hashSeed(`panel:${panelId}:${currentTick()}`)) : Math.random;
  const contributors = ALL_LIVE ? PROVIDERS : PROVIDERS.slice(0, 9);
  // The real endpoint normalizes weightPct over the window's contributors
  // (Σ = 100), so the fixture does too.
  const totalWeight = contributors.reduce((sum, p) => sum + PROVIDER_WEIGHTS[p.slug], 0);
  const providers = contributors.map((p) => {
    const drift = (rand() - 0.5) * 0.004;
    const price = round4(anchor * (1 + drift));
    return {
      providerId: randomUUID(),
      slug: p.slug,
      name: p.name,
      role: p.role,
      price,
      executable: true,
      sampleSize: 40 + Math.floor(rand() * 80),
      method: p.sourceType === "spot-auction" ? "spot-midpoint" : "rental-weighted",
      weightPct: Math.round((PROVIDER_WEIGHTS[p.slug] / totalWeight) * 1000) / 10,
      sigma: round4(0.002 + rand() * 0.004),
      // A daily-cadence source lags the window by design — exercises the
      // delayed lamp in the UI.
      lastObservedAt:
        p.cadenceTier === "daily"
          ? new Date(Date.now() - 2 * 3_600_000).toISOString()
          : new Date(Date.now() - Math.floor(rand() * 120_000)).toISOString(),
    };
  });
  return {
    gpuId,
    panelId,
    status: candidate.status,
    computedAt: candidate.computedAt,
    windowStart: candidate.windowStart,
    windowEnd: candidate.windowEnd,
    providers,
    exclusions: ALL_LIVE
      ? []
      : [{ providerId: randomUUID(), reason: "stale", detail: "no observation inside the panel window" }],
  };
}

// -- HTTP plumbing -------------------------------------------------------------

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { ...CORS, "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function resolvePanel(param) {
  if (PANELS[param]) return param;
  return Object.keys(PANELS).find((id) => PANELS[id].gpuId === param) ?? null;
}

const sseClients = new Set();

function openSse(req, res) {
  res.writeHead(200, {
    ...CORS,
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  sseClients.add(res);
  // The current candidate for every panel lands immediately, so a freshly
  // (re)connected client paints without waiting for the next publish tick.
  for (const panelId of Object.keys(PANELS)) {
    res.write(`event: candidate\ndata: ${JSON.stringify(latestCandidate(panelId))}\n\n`);
  }
  req.on("close", () => {
    sseClients.delete(res);
    console.log(`[mock-oracle] sse close (clients: ${sseClients.size})`);
  });
  console.log(`[mock-oracle] sse open (clients: ${sseClients.size})`);
}

function broadcast() {
  if (sseClients.size === 0) return;
  for (const panelId of Object.keys(PANELS)) {
    const frame = `event: candidate\ndata: ${JSON.stringify(latestCandidate(panelId))}\n\n`;
    for (const res of sseClients) res.write(frame);
  }
}

function health() {
  if (!UNHEALTHY) {
    return { code: 200, body: { status: "healthy", db: true, collectors: PROVIDERS.map((p) => ({
      collectorId: `collector-${p.slug}`,
      providerSlug: p.slug,
      breakerOpen: false,
      breakerOpenedAt: null,
      lastSuccessAt: new Date(Date.now() - 30_000).toISOString(),
      lastFailureAt: null,
      lastFailureKind: null,
      consecutiveFailures: 0,
    })) } };
  }
  return { code: 503, body: { status: "unhealthy", db: false, collectors: PROVIDERS.map((p) => ({
    collectorId: `collector-${p.slug}`,
    providerSlug: p.slug,
    breakerOpen: true,
    breakerOpenedAt: new Date(Date.now() - 120_000).toISOString(),
    lastSuccessAt: new Date(Date.now() - 600_000).toISOString(),
    lastFailureAt: new Date(Date.now() - 30_000).toISOString(),
    lastFailureKind: "db",
    consecutiveFailures: 7,
  })) } };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "GET only" });
  }

  if (path === "/v1/stream/sse") return openSse(req, res);

  if (path === "/v1/prices") {
    return sendJson(res, 200, { prices: Object.keys(PANELS).map(latestCandidate) });
  }

  if (path === "/v1/providers") {
    return sendJson(res, 200, { providers: PROVIDERS });
  }

  if (path === "/v1/health") {
    const { code, body } = health();
    return sendJson(res, code, body);
  }

  const pricesMatch = path.match(/^\/v1\/prices\/([^/]+)$/);
  if (pricesMatch) {
    const panelId = resolvePanel(decodeURIComponent(pricesMatch[1]));
    if (!panelId) {
      return sendJson(res, 404, { error: `"${pricesMatch[1]}" is neither a panel id nor a settled gpu id` });
    }
    return sendJson(res, 200, latestCandidate(panelId));
  }

  const historyMatch = path.match(/^\/v1\/prices\/([^/]+)\/history$/);
  if (historyMatch) {
    const panelId = resolvePanel(decodeURIComponent(historyMatch[1]));
    if (!panelId) {
      return sendJson(res, 404, { error: `"${historyMatch[1]}" is neither a panel id nor a settled gpu id` });
    }
    const limit = Number(url.searchParams.get("limit") ?? 100);
    return sendJson(res, 200, { history: historyFor(panelId, Number.isFinite(limit) ? limit : 100) });
  }

  const panelMatch = path.match(/^\/v1\/prices\/([^/]+)\/providers$/);
  if (panelMatch) {
    const panelId = resolvePanel(decodeURIComponent(panelMatch[1]));
    if (!panelId) {
      return sendJson(res, 404, { error: `"${panelMatch[1]}" is neither a panel id nor a settled gpu id` });
    }
    return sendJson(res, 200, panelProviders(panelId));
  }

  // Server-bucketed OHLC over the fixture's own candidate series — the same
  // contract as the real /candles endpoint: epoch-ms or ISO from/to, an
  // interval allowlist, a bucket cap, oldest-first candles, samples per
  // bucket. Buckets with no observations do not exist (no interpolation).
  const candlesMatch = path.match(/^\/v1\/prices\/([^/]+)\/candles$/);
  if (candlesMatch) {
    const panelId = resolvePanel(decodeURIComponent(candlesMatch[1]));
    if (!panelId) {
      return sendJson(res, 404, { error: `"${candlesMatch[1]}" is neither a panel id nor a settled gpu id` });
    }
    const CANDLE_INTERVALS_SEC = [60, 300, 900, 1800, 3600, 21600, 43200, 86400, 604800];
    const CANDLE_MAX_BUCKETS = 2000;
    const intervalSec = Number(url.searchParams.get("intervalSec") ?? 60);
    if (!CANDLE_INTERVALS_SEC.includes(intervalSec)) {
      return sendJson(res, 400, { error: `intervalSec must be one of ${CANDLE_INTERVALS_SEC.join(", ")}` });
    }
    // Absent → default; present but unparseable → NaN → 400 (matching the
    // real server, which never silently substitutes for invalid input).
    const parseTime = (v, dflt) => {
      if (v === null) return dflt;
      const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
      return Number.isNaN(n) ? NaN : n;
    };
    const to = parseTime(url.searchParams.get("to"), Date.now());
    const from = parseTime(url.searchParams.get("from"), to - 24 * 3_600_000);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      return sendJson(res, 400, { error: "from must be a valid time before to" });
    }
    if ((to - from) / (intervalSec * 1000) > CANDLE_MAX_BUCKETS) {
      return sendJson(res, 400, { error: "window exceeds the bucket cap" });
    }
    // Candidates inside the window (historyFor is newest-first; newest last
    // here), bucketed the way the real server buckets index_candidates.
    const intervalMs = intervalSec * 1000;
    const ticks = Math.ceil((to - from) / PUBLISH_MS) + 2;
    const oldestTick = Math.floor(from / PUBLISH_MS) - 1;
    const inWindow = [];
    for (let i = 0; i < ticks; i++) {
      const c = candidateAt(panelId, oldestTick + i);
      const t = Date.parse(c.computedAt);
      if (t >= from && t < to && c.price !== null) inWindow.push({ t, price: c.price });
    }
    const buckets = new Map();
    for (const { t, price } of inWindow) {
      const bucketT = Math.floor(t / intervalMs) * intervalMs;
      const b = buckets.get(bucketT);
      if (b) {
        b.high = Math.max(b.high, price);
        b.low = Math.min(b.low, price);
        b.close = price;
        b.samples += 1;
      } else {
        buckets.set(bucketT, { t: bucketT, open: price, high: price, low: price, close: price, samples: 1 });
      }
    }
    const candles = [...buckets.values()].sort((a, b) => a.t - b.t);
    return sendJson(res, 200, {
      gpuId: PANELS[panelId].gpuId,
      panelId,
      intervalSec,
      from,
      to,
      candles,
    });
  }

  return sendJson(res, 404, { error: `no route for ${path}` });
});

server.listen(PORT, () => {
  const flags = [
    `status=${STATUS}`,
    UNHEALTHY ? "health=unhealthy" : "health=healthy",
    FLAP ? "flap" : null,
    SPARSE ? "sparse" : null,
    ALL_LIVE ? "all-live" : null,
    DETERMINISTIC ? "deterministic" : null,
  ].filter(Boolean).join(" ");
  console.log(`[mock-oracle] listening on http://127.0.0.1:${PORT} (${flags})`);
  console.log(`[mock-oracle] publish cadence ${PUBLISH_MS / 1000}s · history depth ${HISTORY_LIMIT}`);
});

// Publish tick: new candidates to every connected stream client.
setInterval(broadcast, PUBLISH_MS);

// Heartbeat, invisible to EventSource but kept for wire fidelity.
setInterval(() => {
  for (const res of sseClients) res.write(": ping\n\n");
}, PING_MS);

// Reconnect drill: cut every open stream; EventSource retries natively.
if (FLAP) {
  setInterval(() => {
    for (const res of sseClients) {
      sseClients.delete(res);
      res.end();
    }
    console.log(`[mock-oracle] flapped ${FLAP_MS / 1000}s — streams closed`);
  }, FLAP_MS);
}
