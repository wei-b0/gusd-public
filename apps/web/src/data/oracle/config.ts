/**
 * Oracle integration config. `NEXT_PUBLIC_*` values are inlined into the
 * bundle at build time (literal member access is required for inlining), so
 * a change needs a dev-server restart / rebuild — noted in .env.example.
 */

export type DataSource = "oracle" | "mock";

/** Oracle by default; `NEXT_PUBLIC_DATA_SOURCE=mock` opts out to the
 *  deterministic simulated universe (CI, rasters, offline demos). */
export const DATA_SOURCE: DataSource =
  process.env.NEXT_PUBLIC_DATA_SOURCE === "mock" ? "mock" : "oracle";

export const ORACLE_BASE_URL =
  process.env.NEXT_PUBLIC_ORACLE_URL ?? "http://127.0.0.1:8080";

/** A candidate younger than this is live — the publisher's freshness gate
 *  (PUBLISHER_MAX_FRESHNESS_MS): older candidates are refused publication. */
export const LIVE_MAX_AGE_MS = 300_000;

/** Past this age the engine itself would have stopped carrying the value
 *  forward (stale.carryForwardWindowMs) — the number is no longer truth. */
export const STALE_MAX_AGE_MS = 86_400_000;

/** Poll cadence when the SSE stream is down (candidates change on compute,
 *  debounced ≥10s apart per GPU; 30s never misses a publication window). */
export const POLL_INTERVAL_MS = 30_000;

/** EventSource never surfaces `: ping` comments, and candidates are
 *  legitimately sparse — silence is not proof of health. If nothing has
 *  landed (event or successful poll) for this long while "live", resync
 *  once over REST to resolve the ambiguity. */
export const WATCHDOG_MS = 90_000;

/** The history endpoint clamps to 500 (apps/oracle server.ts). */
export const HISTORY_LIMIT = 500;

/** Cooldown before an uncovered candle window is requested again after a
 *  failed fetch — a retry on every notify would hammer a struggling oracle. */
export const CANDLE_RETRY_MS = 30_000;

/** Cadence of the dedicated health tick. The stream paths only refresh
 *  health on resync (after 90s of silence) — on a busy live stream the
 *  collector-health table would otherwise go minutes stale. One cheap GET
 *  per minute keeps it current. */
export const HEALTH_POLL_MS = 60_000;

/** Per-request REST timeout. */
export const FETCH_TIMEOUT_MS = 5_000;
