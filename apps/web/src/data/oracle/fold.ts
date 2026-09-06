/**
 * Grid-faithful realtime folding of one canonical benchmark print into a
 * loaded candle grid.
 *
 * The server's /candles response sits on a regular, epoch-aligned grid:
 * real buckets stay as computed, silent intervals are carried flat at the
 * previous close (samples 0, flagged `carried`), and nothing is carried
 * before the first real bucket. The client-side fold must reproduce those
 * semantics exactly — otherwise the trailing edge (live SSE merges) drifts
 * from the next server refetch and the chart's `t` spacing lies.
 *
 * Three parity rules the naive fold gets wrong:
 *   1. a print landing in a CARRIED bucket promotes it to a real bucket
 *      whose open is that print (the server's open for the interval is its
 *      first real computation — not the carried level, and samples 1, not
 *      0+1),
 *   2. a print landing BEYOND the last bucket with silent intervals in
 *      between splices the carried buckets in first, keeping the grid
 *      regular between onTicks,
 *   3. a print landing BEFORE the first real bucket (but inside the loaded
 *      window) prepends only the real bucket — never carried history.
 *
 * Pure and clock-free: the feed store owns state, this owns semantics, and
 * both are unit-testable in isolation. This is the single folding
 * implementation — the store's merges and the TV datafeed's onTick path both
 * go through it, so the chart never re-derives OHLC client-side.
 */

import type { CandleDto } from "./dto";

/** A pathological gap would synthesize thousands of carried buckets; that is
 *  broken input, not a sparse series — refuse the fold rather than invent
 *  history. Matches the server's own per-request bucket cap. */
const MAX_FILL_BUCKETS = 2000;

export interface FoldPrint {
  /** Computed-at instant of the print, epoch ms. */
  t: number;
  /** The benchmark price the print asserted. */
  price: number;
}

/** Fold one print into `buckets` (ascending, regular grid). Returns the next
 *  array, or null when nothing changed (print outside the loaded window, or
 *  a gap too wide to carry). */
export function foldCandidateIntoBuckets(
  buckets: readonly CandleDto[],
  print: FoldPrint,
  intervalSec: number,
  fromMs: number,
): CandleDto[] | null {
  const intervalMs = intervalSec * 1000;
  const bucketT = Math.floor(print.t / intervalMs) * intervalMs;
  if (bucketT < fromMs) return null; // outside the loaded window

  // Locate the last bucket at or before the print's bucket.
  let idx = buckets.length - 1;
  while (idx >= 0 && buckets[idx]!.t > bucketT) idx -= 1;
  const hit = idx >= 0 ? buckets[idx]! : null;

  const realBucket = (t: number, price: number): CandleDto => ({
    t,
    open: price,
    high: price,
    low: price,
    close: price,
    samples: 1,
  });
  const carriedBucket = (t: number, close: number): CandleDto => ({
    t,
    open: close,
    high: close,
    low: close,
    close,
    samples: 0,
    carried: true,
  });

  if (hit && hit.t === bucketT) {
    if (hit.samples === 0 || hit.carried) {
      // Promote a carried bucket: the first real print IS the interval's open.
      const next = buckets.slice();
      next[idx] = realBucket(hit.t, print.price);
      return next;
    }
    const next = buckets.slice();
    next[idx] = {
      t: hit.t,
      open: hit.open,
      high: Math.max(hit.high, print.price),
      low: Math.min(hit.low, print.price),
      close: print.price,
      samples: hit.samples + 1,
    };
    return next;
  }

  if (hit) {
    // New bucket beyond the hit: carry every silent step first so the grid
    // stays regular, then append the real bucket.
    if ((bucketT - hit.t) / intervalMs - 1 > MAX_FILL_BUCKETS) return null;
    const fill: CandleDto[] = [];
    for (let t = hit.t + intervalMs; t < bucketT; t += intervalMs) {
      fill.push(carriedBucket(t, hit.close));
    }
    return [
      ...buckets.slice(0, idx + 1),
      ...fill,
      realBucket(bucketT, print.price),
      ...buckets.slice(idx + 1),
    ];
  }

  // Before the first real bucket: prepend the single real bucket only —
  // nothing is carried from before the first observation (server semantics).
  return [realBucket(bucketT, print.price), ...buckets];
}
