/**
 * Pure mappers from oracle wire data (src/data/oracle/dto) to domain shapes
 * (src/domain/types). No fetching, no clocks of their own — every mapper that
 * needs a notion of "now" takes it as a parameter, so the feed store owns the
 * clock and these stay unit-testable.
 *
 * Honesty rules baked in here:
 *   - a mapper never invents a value the wire does not carry (coverage and
 *     ingest latency map to null; the UI renders "—"),
 *   - a null price is never promoted to a number (the Index series is only
 *     what the oracle actually asserted),
 *   - a delta against a missing anchor is null, never a substitute.
 */

import type { CandidateDto, CandleDto, PanelProvidersDto } from "./dto";
import type {
  Candle,
  IndexPoint,
  IndexQuality,
  IndexStatus,
  IndexTelemetry,
  ProviderObservation,
} from "@/domain/types";
import { LIVE_MAX_AGE_MS, STALE_MAX_AGE_MS } from "./config";

/** Trailing-24h window. */
const DAY_MS = 86_400_000;

/** Trailing-1h window (publications-per-hour telemetry). */
const HOUR_MS = 3_600_000;

/**
 * How far from now−24h the anchor candidate may sit and still ground a 24h
 * change. The real history endpoint caps at 500 candidates — on a live panel
 * that is only a few hours of depth — so a tighter anchor would make the
 * field almost always null; ±6h keeps it available once a day of history
 * accrues, and null (→ "—") before that. Never backfilled from mock.
 */
export const CHANGE24_TOLERANCE_MS = 6 * 3_600_000;

/** Age classification of one candidate against the freshness gates: the
 *  publisher refuses candidates older than LIVE_MAX_AGE_MS, and the engine
 *  stops carrying a value forward past STALE_MAX_AGE_MS. */
export function classifyAge(computedAt: string, now: number): "live" | "stale" | "unavailable" {
  const t = Date.parse(computedAt);
  if (!Number.isFinite(t)) return "unavailable";
  const age = now - t;
  if (age <= LIVE_MAX_AGE_MS) return "live";
  if (age <= STALE_MAX_AGE_MS) return "stale";
  return "unavailable";
}

/** Wire status → domain indexStatus. `withheld`/`frozen` pass through — the
 *  oracle refusing to assert a price is its own state, not an age. Everything
 *  else (healthy, degraded, unknown strings) classifies by freshness:
 *  degraded panels still publish fresh candidates. */
export function mapIndexStatus(candidate: CandidateDto, now: number): IndexStatus {
  if (candidate.status === "withheld" || candidate.status === "frozen") return candidate.status;
  return classifyAge(candidate.computedAt, now);
}

/** Candidate → IndexQuality. sourcesLive/Total are the wire's
 *  contributing/observed counts; publication identity is the calcHash
 *  prefix; latency and coverage have no server source and stay null. */
export function mapQuality(candidate: CandidateDto): IndexQuality {
  return {
    sourcesLive: candidate.providersContributing,
    sourcesTotal: candidate.providersObserved,
    coveragePct: null,
    latencyMs: null,
    publication: candidate.calcHash.slice(0, 7),
    updatedAt: Date.parse(candidate.computedAt),
  };
}

/** Candidate series (oldest-first) → the latest panel's wire telemetry, plus
 *  publications-per-hour counted from the series' own computedAt stamps
 *  (deduped by calcHash, like the Index points — a re-fetched candidate is
 *  one landing, not two). Every field is the wire's own; a withheld panel
 *  still landed, so it still counts. Empty series → null (never zeros posed
 *  as live telemetry). */
export function mapIndexTelemetry(
  candidates: readonly CandidateDto[],
  now: number,
): IndexTelemetry {
  if (candidates.length === 0) return EMPTY_TELEMETRY;
  const latest = candidates[candidates.length - 1]!;
  const seen = new Set<string>();
  let publications1h = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i]!;
    if (seen.has(c.calcHash)) continue;
    seen.add(c.calcHash);
    const t = Date.parse(c.computedAt);
    if (!Number.isFinite(t)) continue;
    // Walked newest-first: the first duplicate-free stamp older than the
    // hour window ends the count.
    if (t < now - HOUR_MS) break;
    publications1h++;
  }
  return {
    dispersion: latest.dispersion,
    confidenceLow: latest.confidenceLow,
    confidenceHigh: latest.confidenceHigh,
    sourcesObserved: latest.providersObserved,
    sourcesContributing: latest.providersContributing,
    publications1h,
    lastPublishedAt: Date.parse(latest.computedAt) || null,
  };
}

const EMPTY_TELEMETRY: IndexTelemetry = {
  dispersion: null,
  confidenceLow: null,
  confidenceHigh: null,
  sourcesObserved: null,
  sourcesContributing: null,
  publications1h: null,
  lastPublishedAt: null,
};

/** Candidate series → oldest-first IndexPoints, deduped by publication hash
 *  (a candidate re-fetched over REST and re-received over SSE is one point,
 *  not two) and stripped of null prices. Sorts by timestamp, so both the
 *  wire's newest-first history arrays and the feed's oldest-first accumulations
 *  arrive at the same order. */
export function historyToIndexPoints(history: readonly CandidateDto[]): IndexPoint[] {
  const seen = new Set<string>();
  const points: IndexPoint[] = [];
  for (const candidate of history) {
    if (candidate.price === null || seen.has(candidate.calcHash)) continue;
    const t = Date.parse(candidate.computedAt);
    if (!Number.isFinite(t)) continue;
    seen.add(candidate.calcHash);
    points.push({ t, value: candidate.price });
  }
  return points.sort((a, b) => a.t - b.t);
}

/** Index change over trailing 24h: last point vs the point nearest
 *  now−24h, null when no candidate lands within the tolerance (the common
 *  case until the panel accrues a day of history). */
export function deriveChange24h(points: readonly IndexPoint[], now: number): number | null {
  if (points.length === 0) return null;
  const latest = points[points.length - 1]!;
  const anchor = now - DAY_MS;
  let baseline: IndexPoint | null = null;
  let best = Infinity;
  for (const p of points) {
    const d = Math.abs(p.t - anchor);
    if (d < best) {
      best = d;
      baseline = p;
    }
  }
  if (baseline === null || best > CHANGE24_TOLERANCE_MS) return null;
  if (baseline.value <= 0 || latest.value <= 0) return null;
  return (latest.value / baseline.value - 1) * 100;
}

/** Last non-null price across an oldest-first candidate series — the
 *  last-known Index when the newest candidate withheld its price. */
export function lastKnownIndexPrice(candidates: readonly CandidateDto[]): number | null {
  for (let i = candidates.length - 1; i >= 0; i--) {
    const price = candidates[i]!.price;
    if (price !== null) return price;
  }
  return null;
}

// -- canonical benchmark series (server-bucketed /candles) -------------------
//
// The in-memory candidate history caps at 500 rows, so client-side bucketing
// can only ever cover hours. The oracle's /candles endpoint buckets the
// canonical series in the database server-side — these mappers adapt it.

/** Wire buckets → domain candles (samples stay behind — the chart draws
 *  OHLC, the count is the server's audit). */
export function bucketsToCandles(buckets: readonly CandleDto[]): Candle[] {
  return buckets.map((b) => ({ t: b.t, open: b.open, high: b.high, low: b.low, close: b.close }));
}

/** Wire buckets → IndexPoints of closes — the Index line for ranges the
 *  candidate history is too shallow to cover. */
export function bucketsToPoints(buckets: readonly CandleDto[]): IndexPoint[] {
  return buckets.map((b) => ({ t: b.t, value: b.close }));
}

/** Sparkline values from the last `max` bucket closes of a loaded series. */
export function sparklineFromBuckets(buckets: readonly CandleDto[], max = 48): number[] {
  return buckets.slice(-max).map((b) => b.close);
}

/**
 * Window stats over server-bucketed candles: open is the OPEN of the bucket
 * nearest the window start (inside the tolerance — a bucket open is the
 * first computed benchmark in that interval), high/low the extremes across
 * every bucket at/after the start. Coverage gates every figure: the series
 * must reach back to the window start (within `toleranceMs`) or nothing is
 * posed — a max over a partial window fabricated as the window's high is
 * exactly the dishonesty this refuses.
 */
export function deriveWindowStatsFromCandles(
  candles: readonly Candle[],
  now: number,
  windowMs: number,
  toleranceMs: number,
): WindowStats {
  const empty: WindowStats = { open: null, high: null, low: null };
  if (candles.length === 0) return empty;
  const start = now - windowMs;
  if (candles[0]!.t > start + toleranceMs) return empty;
  const inWindow = candles.filter((c) => c.t >= start);
  if (inWindow.length === 0) return empty;
  let open: number | null = null;
  let best = Infinity;
  for (const c of inWindow) {
    const d = Math.abs(c.t - start);
    if (d < best) {
      best = d;
      open = c.open;
    }
  }
  if (best > toleranceMs) open = null;
  let high = -Infinity;
  let low = Infinity;
  for (const c of inWindow) {
    high = Math.max(high, c.high);
    low = Math.min(low, c.low);
  }
  return { open, high, low };
}

/** Last `max` real prints as sparkline closes — the register's line is the
 *  Index's own recent history, never a simulated series. */
export function sparklineFromPoints(points: readonly IndexPoint[], max = 48): number[] {
  return points.slice(-max).map((p) => p.value);
}

export interface WindowStats {
  open: number | null;
  high: number | null;
  low: number | null;
}

/**
 * Reference window stats (open/high/low) over a trailing window, derived
 * exclusively from real prints. Coverage gates every figure: the window
 * counts as covered only when the series reaches back to its start (within
 * `toleranceMs` — the same pragmatism as the 24h change anchor, since the
 * history endpoint caps at 500 candidates). open is the print nearest the
 * window start inside the tolerance; high/low are the extremes of the
 * covered window. No coverage, no stats — a max over a partial window posed
 * as the window's high would fabricate.
 */
export function deriveWindowStats(
  points: readonly IndexPoint[],
  now: number,
  windowMs: number,
  toleranceMs: number,
): WindowStats {
  const empty: WindowStats = { open: null, high: null, low: null };
  if (points.length === 0) return empty;
  const start = now - windowMs;
  if (points[0]!.t > start + toleranceMs) return empty;
  const inWindow = points.filter((p) => p.t >= start);
  if (inWindow.length === 0) return empty;
  let open: number | null = null;
  let best = Infinity;
  for (const p of inWindow) {
    const d = Math.abs(p.t - start);
    if (d < best) {
      best = d;
      open = p.value;
    }
  }
  if (best > toleranceMs) open = null;
  let high = -Infinity;
  let low = Infinity;
  for (const p of inWindow) {
    high = Math.max(high, p.value);
    low = Math.min(low, p.value);
  }
  return { open, high, low };
}

/**
 * Panel contributors → ProviderObservation rows. The oracle publishes what
 * it measures — price, weight, method, last observation — and nothing else,
 * so coverage stays null. Lamp semantics follow the Age column: an
 * observation fresher than the publisher's gate is live; anything older is
 * delayed (its influence is aging out); unparseable/absent timestamps are
 * delayed rather than live — freshness we cannot vouch for is not live.
 *
 * Exclusions are omitted in v1: the wire carries only a providerId for them
 * (no name join available client-side).
 */
export function mapProviders(panel: PanelProvidersDto, now: number): ProviderObservation[] {
  return panel.providers.map((p) => {
    const observedAt = p.lastObservedAt === null ? null : Date.parse(p.lastObservedAt);
    const age = observedAt === null || !Number.isFinite(observedAt) ? null : now - observedAt;
    const status: ProviderObservation["status"] =
      age === null ? "delayed" : age <= LIVE_MAX_AGE_MS ? "live" : age <= STALE_MAX_AGE_MS ? "delayed" : "stale";
    return {
      id: p.providerId,
      provider: p.name,
      priceUsdPerGpuHour: p.price,
      weightPct: p.weightPct,
      coveragePct: null,
      lastObservedAt: observedAt,
      status,
    };
  });
}