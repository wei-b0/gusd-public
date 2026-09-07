/**
 * Bucket math for the time-series aggregates (pool_stats_hourly,
 * protocol_stats_daily). Bucket starts are floor divisions of the event's
 * block timestamp — chain time only, never wall clock (determinism
 * invariant). Dividing then re-multiplying in bigint arithmetic floors
 * exactly at any magnitude.
 */

export const HOUR_SECONDS = 3_600n;
export const DAY_SECONDS = 86_400n;

/** Inclusive start (epoch sec) of the hour bucket containing timestampSec. */
export function hourBucketStart(timestampSec: bigint): bigint {
  return (timestampSec / HOUR_SECONDS) * HOUR_SECONDS;
}

/** Inclusive start (epoch sec) of the day bucket containing timestampSec. */
export function dayBucketStart(timestampSec: bigint): bigint {
  return (timestampSec / DAY_SECONDS) * DAY_SECONDS;
}
