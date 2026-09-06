/**
 * The oracle feed store: one shared, ref-counted connection from the browser
 * to the oracle, holding raw wire state that the composite market-data port
 * overlays onto the mock base layer.
 *
 * Transport doctrine:
 *   - SSE is the one stream. EventSource reconnects natively and is never
 *     recreated on error (that would reset the browser's backoff).
 *   - The stream is deliberately lossy, so every (re)connection resyncs over
 *     REST — the DB is the truth, the stream is the highlight reel.
 *   - While the stream is down, a 30s REST poll keeps data flowing; if that
 *     fails too the feed reports `down` and retries the bootstrap. A poll that
 *     SUCCEEDS is proof the oracle answers, and re-probes the stream — the
 *     browser's native reconnect backoff can otherwise outlast the outage.
 *   - `: ping` comments are invisible to EventSource and candidates are
 *     legitimately sparse, so a 90s watchdog resolves silence: one REST
 *     resync confirms transport health without tearing the stream down.
 *
 * The feed never starts server-side (`start()` guards on `window`), so SSR
 * snapshots are pure mock — hydration-safe by construction. State is retained
 * after the last unsubscribe: StrictMode's double-mount is a no-op, and a
 * remount hydrates instantly from what was already fetched.
 */

import { CANDLE_RETRY_MS, HISTORY_LIMIT, ORACLE_BASE_URL, POLL_INTERVAL_MS, WATCHDOG_MS } from "./config";
import { ORACLE_PANELS } from "./panel-map";
import { createOracleClient, OracleFetchError, type OracleClient } from "./client";
import { foldCandidateIntoBuckets } from "./fold";
import type {
  CandleDto,
  CandidateDto,
  CandlesResponse,
  HealthResponse,
  PanelProvidersDto,
  ProviderDto,
} from "./dto";

export type Connection = "idle" | "connecting" | "live" | "polling" | "down";

/** One loaded candle set over the canonical benchmark series: the server
 *  answered for [fromMs, toMs) at intervalSec, and the trailing edge stays
 *  live by merging candidates as they land. Sets are keyed per gpu by
 *  interval seconds — a deeper request for the same interval absorbs the
 *  shallower one rather than duplicating it. `fetchedAt` timestamps the last
 *  server answer so an empty window stays retry-eligible (see
 *  `ensureCandles`) without being hammered. */
export interface CandleSet {
  intervalSec: number;
  fromMs: number;
  toMs: number;
  buckets: CandleDto[];
  fetchedAt: number;
}

export interface OracleFeedState {
  /** Latest candidate per gpuId (all gpus the oracle reports, not just the
   *  web's opted-in panels). */
  latest: Record<string, CandidateDto>;
  /** Candidate history per gpuId, OLDEST-FIRST, trimmed to HISTORY_LIMIT. */
  history: Record<string, CandidateDto[]>;
  /** Contributor panel behind each panel's latest candidate; null when the
   *  candidate exists but no panel could be fetched (or none ever computed). */
  panelProviders: Record<string, PanelProvidersDto | null>;
  /** Provider registry from GET /v1/providers. */
  providers: ProviderDto[];
  /** Server-bucketed OHLC over the canonical benchmark series, per gpu per
   *  interval, loaded lazily by the market-data overlay. */
  candles: Record<string, Record<string, CandleSet>>;
  /** Last-parsed health document (a 503 body is data). */
  health: HealthResponse | null;
  connection: Connection;
  /** Time of the last successful data landing (REST response or SSE frame) —
   *  the watchdog's freshness signal for the transport, not the data. */
  lastDataAt: number | null;
  lastError: string | null;
  version: number;
}

const INITIAL_STATE: OracleFeedState = {
  latest: {},
  history: {},
  panelProviders: {},
  providers: [],
  candles: {},
  health: null,
  connection: "idle",
  lastDataAt: null,
  lastError: null,
  version: 0,
};

const PANEL_GPUS = Object.values(ORACLE_PANELS).map((ref) => ref.gpuId);

interface CandidateFrame {
  type?: string;
  candidate?: CandidateDto;
}

export class OracleFeedStore {
  private client: OracleClient;
  private listeners = new Set<() => void>();
  private state: OracleFeedState = INITIAL_STATE;

  private source: EventSource | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  /** In-flight candle fetches (gpuId:intervalSec) — one request per window,
   *  never a stack of identical fetches across render ticks. */
  private candlePending = new Set<string>();
  private candleAttemptAt = new Map<string, number>();

  constructor(client: OracleClient = createOracleClient()) {
    this.client = client;
  }

  getState(): OracleFeedState {
    return this.state;
  }

  /** Ref-counted: the first subscriber boots the connection, the last
   *  unsubscribe tears it down. Fetched state is retained either way, so a
   *  remount (StrictMode included) hydrates instantly with no refetch. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  /** Make sure a candle set at `intervalSec` reaching back to `fromMs` is
   *  loading for this gpu. A covered window (or one in flight, or cooling
   *  down after a failure) is a no-op; the answer lands as a state commit,
   *  so callers read optimistically and re-render on arrival. An EMPTY set
   *  covers its window only until its fetch goes stale — a legitimately
   *  emptied series must retry, but on the same cooldown as a failure so a
   *  young panel is never hammered per render. */
  ensureCandles(gpuId: string, intervalSec: number, fromMs: number): void {
    if (typeof window === "undefined") return; // SSR never connects.
    const key = `${gpuId}:${intervalSec}`;
    const set = this.state.candles[gpuId]?.[String(intervalSec)];
    if (set && set.fromMs <= fromMs) {
      if (set.buckets.length > 0) return;
      if (Date.now() - set.fetchedAt < CANDLE_RETRY_MS) return;
    }
    if (this.candlePending.has(key)) return;
    const lastAttempt = this.candleAttemptAt.get(key);
    if (lastAttempt !== undefined && Date.now() - lastAttempt < CANDLE_RETRY_MS) return;
    this.candleAttemptAt.set(key, Date.now());
    this.candlePending.add(key);
    void this.client
      .getCandles(gpuId, intervalSec, fromMs, Date.now())
      .then(
        (res) => this.absorbCandleSet(gpuId, res, fromMs),
        () => {
          // Leave the window uncovered — the next ensure after the cooldown
          // retries; a struggling oracle is not spammed per render.
        },
      )
      .finally(() => {
        this.candlePending.delete(key);
      });
  }

  /** Unconditional refetch of one loaded window (resync path: REST is the
   *  truth, so accumulated client merges get re-bucketed by the server). */
  private refetchCandles(gpuId: string, set: CandleSet): void {
    const key = `${gpuId}:${set.intervalSec}`;
    if (this.candlePending.has(key)) return;
    this.candlePending.add(key);
    void this.client
      .getCandles(gpuId, set.intervalSec, set.fromMs, Date.now())
      .then(
        (res) => this.absorbCandleSet(gpuId, res, set.fromMs),
        () => {},
      )
      .finally(() => {
        this.candlePending.delete(key);
      });
  }

  // -- lifecycle -----------------------------------------------------------

  private start(): void {
    if (typeof window === "undefined") return; // SSR never connects.
    if (this.source || this.pollTimer || this.retryTimer) return; // already running
    this.setConnection("connecting");
    void this.bootstrap();
  }

  private stop(): void {
    this.source?.close();
    this.source = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.setConnection("idle");
  }

  /** First contact: fetch everything the overlay needs in parallel, then open
   *  the stream. Total failure means the oracle is unreachable — report down
   *  and retry the whole bootstrap on the poll cadence. */
  private async bootstrap(): Promise<void> {
    const requests: Promise<void>[] = [
      this.client.listPrices().then((prices) => {
        for (const candidate of prices) this.mergeCandidate(candidate);
      }),
      this.client.listProviders().then((providers) => {
        this.commit({ providers });
      }),
      this.client.getHealth().then((health) => {
        this.commit({ health });
      }),
    ];
    for (const gpuId of PANEL_GPUS) {
      requests.push(
        this.client.getHistory(gpuId, HISTORY_LIMIT).then((history) => {
          this.commit({ history: { ...this.state.history, [gpuId]: history.slice(-HISTORY_LIMIT) } });
        }),
      );
      requests.push(this.fetchPanel(gpuId));
    }

    const results = await Promise.allSettled(requests);
    // Health/panel 404s settle fulfilled; only real failures reject.
    const anyOk = results.some((r) => r.status === "fulfilled");
    if (this.listeners.size === 0) return; // torn down while bootstrapping
    if (!anyOk) {
      const first = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      this.commit({
        connection: "down",
        lastError: describeRejection(first),
      });
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.listeners.size > 0) {
          this.setConnection("connecting");
          void this.bootstrap();
        }
      }, POLL_INTERVAL_MS);
      return;
    }
    this.noteSuccess();
    this.openStream();
    this.startWatchdog();
  }

  private openStream(): void {
    if (this.source) return;
    const source = new EventSource(`${ORACLE_BASE_URL}/v1/stream/sse`);
    this.source = source;
    source.onopen = () => {
      if (this.source !== source) return;
      this.setConnection("live");
      // Reconnect = potentially missed frames. REST is the truth; resync.
      void this.resync();
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    };
    source.addEventListener("candidate", (event: MessageEvent<string>) => {
      if (this.source !== source) return;
      try {
        const frame = JSON.parse(event.data) as CandidateFrame;
        if (frame.type === "candidate" && frame.candidate) {
          if (this.mergeCandidate(frame.candidate)) this.noteSuccess();
        }
      } catch {
        // A malformed frame is noise, not a transport failure.
      }
    });
    source.onerror = () => {
      if (this.source !== source) return;
      // Do NOT close or recreate — EventSource retries with native backoff.
      // Meanwhile keep data flowing over REST.
      this.setConnection("polling");
      if (!this.pollTimer) {
        this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
      }
    };
  }

  // -- REST sync paths -----------------------------------------------------

  /** Full resync: prices, health, history, panels. Runs on (re)connect and
   *  when the watchdog catches silence. */
  private async resync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const [prices, health, histories] = await Promise.allSettled([
        this.client.listPrices(),
        this.client.getHealth(),
        Promise.all(
          PANEL_GPUS.map(
            async (gpuId) =>
              [gpuId, await this.client.getHistory(gpuId, HISTORY_LIMIT)] as const,
          ),
        ),
      ]);
      if (prices.status === "fulfilled") {
        for (const candidate of prices.value) this.mergeCandidate(candidate);
      }
      if (health.status === "fulfilled") {
        this.commit({ health: health.value });
      }
      if (histories.status === "fulfilled") {
        const history = { ...this.state.history };
        for (const [gpuId, rows] of histories.value) {
          history[gpuId] = rows.slice(-HISTORY_LIMIT);
        }
        this.commit({ history });
      }
      await Promise.allSettled(PANEL_GPUS.map((gpuId) => this.fetchPanel(gpuId)));
      // Loaded candle windows refetch too: the stream is lossy and REST is
      // the truth, so a resync re-buckets the tail from the server's own
      // series rather than trusting accumulated client merges.
      for (const [gpuId, intervals] of Object.entries(this.state.candles)) {
        for (const set of Object.values(intervals)) {
          this.refetchCandles(gpuId, set);
        }
      }
      if (prices.status === "fulfilled" || health.status === "fulfilled") this.noteSuccess();
      else this.commit({ lastError: "oracle resync failed" });
    } finally {
      this.syncing = false;
    }
  }

  /** Poll fallback while the stream is down: the cheap pair only — history
   *  and panels resync when the stream itself recovers. */
  private async poll(): Promise<void> {
    const [prices, health] = await Promise.allSettled([this.client.listPrices(), this.client.getHealth()]);
    if (this.listeners.size === 0) return;
    let ok = false;
    if (prices.status === "fulfilled") {
      for (const candidate of prices.value) this.mergeCandidate(candidate);
      ok = true;
    }
    if (health.status === "fulfilled") {
      this.commit({ health: health.value });
      ok = true;
    }
    if (ok) {
      this.noteSuccess();
      // A successful poll is proof the oracle answers again. The EventSource's
      // native backoff can outlast the outage by minutes, so re-establish the
      // stream deliberately — one controlled probe, not the error-loop
      // recreation the doctrine forbids.
      if (this.state.connection === "down") this.setConnection("polling");
      this.reprovisionStream();
    } else {
      this.commit({ connection: "down", lastError: "oracle unreachable" });
    }
  }

  /** While the stream is in the fallback path, a confirmed-healthy REST poll
   *  is the trigger to re-probe it: close the limping EventSource (its native
   *  backoff has grown past the outage by then) and open a fresh one. If the
   *  stream still fails, the next onerror collapses back to polling at the
   *  normal cadence — one deliberate probe per successful poll, never a tight
   *  error loop. */
  private reprovisionStream(): void {
    if (!this.pollTimer) return; // stream isn't in the fallback path
    if (this.source) {
      this.source.close();
      this.source = null;
    }
    this.openStream();
  }

  /** Contributor panel for one gpu. 404 ("no candidate ever computed") is a
   *  legitimate empty answer, stored as null — not an error. */
  private async fetchPanel(gpuId: string): Promise<void> {
    try {
      const panel = await this.client.getPanelProviders(gpuId);
      this.commit({ panelProviders: { ...this.state.panelProviders, [gpuId]: panel } });
    } catch (cause) {
      if (cause instanceof OracleFetchError && cause.status === 404) {
        this.commit({ panelProviders: { ...this.state.panelProviders, [gpuId]: null } });
        return;
      }
      throw cause;
    }
  }

  /** Silence is not proof of health: `: ping` comments are invisible to
   *  EventSource and candidates are legitimately sparse. If nothing has
   *  landed for a while on a "live" connection, one REST resync resolves the
   *  ambiguity (a successful resync refreshes lastDataAt even when nothing
   *  changed — REST and stream agreeing IS the confirmation). */
  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      const { connection, lastDataAt } = this.state;
      if (connection !== "live" || lastDataAt === null) return;
      if (Date.now() - lastDataAt > WATCHDOG_MS) void this.resync();
    }, 15_000);
  }

  // -- state ----------------------------------------------------------------

  /** Insert/replace one candidate if its publication hash is new. Returns
   *  whether anything changed. */
  private mergeCandidate(candidate: CandidateDto): boolean {
    const gpuId = candidate.gpuId;
    const prev = this.state.latest[gpuId];
    if (prev && prev.calcHash === candidate.calcHash) return false;
    const history = this.state.history[gpuId];
    const nextHistory = history ? [...history, candidate].slice(-HISTORY_LIMIT) : history;
    const candles = this.mergeIntoCandles(gpuId, candidate);
    this.commit({
      latest: { ...this.state.latest, [gpuId]: candidate },
      ...(nextHistory ? { history: { ...this.state.history, [gpuId]: nextHistory } } : {}),
      ...(candles ? { candles } : {}),
    });
    return true;
  }

  /** Fold a freshly landed candidate into every loaded candle set of its
   *  gpu. `foldCandidateIntoBuckets` is the single folding implementation —
   *  server-grid parity including carried-bucket promotion and carried fill
   *  across gaps — so the trailing edge matches the next server refetch.
   *  Null-priced candidates (gated computations that asserted no figure)
   *  enter nothing — a bucket fed by a null would invent a level. */
  private mergeIntoCandles(gpuId: string, candidate: CandidateDto): Record<string, Record<string, CandleSet>> | null {
    const sets = this.state.candles[gpuId];
    if (!sets) return null;
    const t = Date.parse(candidate.computedAt);
    const price = candidate.price;
    if (!Number.isFinite(t) || price === null) return null;
    let touched = false;
    const next: Record<string, CandleSet> = { ...sets };
    for (const [intervalKey, set] of Object.entries(sets)) {
      const folded = foldCandidateIntoBuckets(
        set.buckets,
        { t, price },
        Number(intervalKey),
        set.fromMs,
      );
      if (!folded) continue;
      next[intervalKey] = { ...set, buckets: folded };
      touched = true;
    }
    return touched ? { ...this.state.candles, [gpuId]: next } : null;
  }

  /** Absorb a fetched candle set: a concurrently landed deeper set wins the
   *  floor; buckets merge by open time with the fetch's server truth per
   *  bucket. REST is the truth, so an EMPTY response is committed as-is —
   *  the window genuinely has no series (yet), and `ensureCandles`' freshness
   *  rule keeps it retry-eligible. Returns whether the absorption changed
   *  the series STRUCTURALLY (first bucket moved, or the array shrank) —
   *  the signal that a resync re-bucketed history rather than just extended
   *  the tail, and the chart should reload from the server. */
  private absorbCandleSet(gpuId: string, res: CandlesResponse, fromMs: number): boolean {
    const intervalKey = String(res.intervalSec);
    const incumbent = this.state.candles[gpuId]?.[intervalKey];
    const fetched: CandleSet = {
      intervalSec: res.intervalSec,
      fromMs,
      toMs: Date.parse(res.to),
      buckets: res.candles,
      fetchedAt: Date.now(),
    };
    let merged: CandleSet;
    if (!incumbent || incumbent.fromMs <= fromMs) {
      merged = fetched;
    } else {
      // The incumbent reaches further back (a wider request landed first):
      // keep its older buckets, take the fetch's buckets from the overlap on.
      const seam = fetched.buckets.length > 0 ? fetched.buckets[0]!.t : Infinity;
      const older = incumbent.buckets.filter((b) => b.t < seam);
      const byT = new Map<number, CandleDto>();
      for (const b of [...older, ...fetched.buckets]) byT.set(b.t, b);
      merged = {
        ...fetched,
        fromMs: incumbent.fromMs,
        buckets: [...byT.values()].sort((a, b) => a.t - b.t),
      };
    }
    const structural = (() => {
      if (!incumbent) return false; // first load — the chart is fetching anyway
      if (incumbent.buckets.length === 0) return merged.buckets.length > 0;
      if (merged.buckets.length === 0) return true;
      return (
        merged.buckets[0]!.t !== incumbent.buckets[0]!.t ||
        merged.buckets.length < incumbent.buckets.length
      );
    })();
    this.commit({
      candles: {
        ...this.state.candles,
        [gpuId]: { ...this.state.candles[gpuId], [intervalKey]: merged },
      },
    });
    return structural;
  }

  /** Public ingest for the chart's datafeed: absorb a /candles response the
   *  store didn't fetch itself, so the store (stats, sparklines) and the
   *  chart share one series state instead of issuing duplicate GETs.
   *  Returns the structural-change signal — see `absorbCandleSet`. */
  ingestCandles(gpuId: string, res: CandlesResponse, fromMs: number): boolean {
    return this.absorbCandleSet(gpuId, res, fromMs);
  }

  private noteSuccess(): void {
    this.commit({ lastDataAt: Date.now(), lastError: null });
  }

  private setConnection(connection: Connection): void {
    if (this.state.connection === connection) return;
    this.commit({ connection });
  }

  /** Replace state immutably (useSyncExternalStore needs Object.is-stable
   *  references between changes) and notify. */
  private commit(partial: Partial<OracleFeedState>): void {
    this.state = { ...this.state, ...partial, version: this.state.version + 1 };
    for (const listener of this.listeners) listener();
  }
}

function describeRejection(result?: PromiseSettledResult<void>): string {
  if (result?.status === "rejected") {
    const cause = result.reason;
    if (cause instanceof OracleFetchError) return cause.message;
    return String(cause);
  }
  return "oracle unreachable";
}

/** The shared feed — one process-wide store so every page and the composite
 *  port observe a single connection. */
let feed: OracleFeedStore | null = null;

export function getOracleFeed(baseUrl?: string): OracleFeedStore {
  if (!feed) feed = new OracleFeedStore(baseUrl ? createOracleClient(baseUrl) : undefined);
  return feed;
}
