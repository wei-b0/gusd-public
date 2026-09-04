/**
 * Robust statistics primitives. All pure and deterministic: no randomness,
 * no clock, no I/O. Sort order is numeric ascending, always.
 */

/** Arithmetic median; null for an empty list (never zero — missing is not zero). */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Median absolute deviation. `center` may be passed to avoid recomputing
 * (must be the actual median for MAD to mean anything).
 */
export function mad(values: readonly number[], center?: number | null): number | null {
  if (values.length === 0) return null;
  const c = center === undefined ? median(values) : center;
  if (c === null) return null;
  return median(values.map((v) => Math.abs(v - c)));
}

/**
 * Weighted median: the smallest value where cumulative weight reaches half
 * of total weight. Ties break by first occurrence in the sorted order
 * (stable) — deterministic for identical inputs.
 */
export function weightedMedian(
  values: readonly { value: number; weight: number }[],
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((acc, v) => acc + v.weight, 0);
  if (total <= 0) return null;
  let cum = 0;
  for (const v of sorted) {
    cum += v.weight;
    if (cum >= total / 2) return v.value;
  }
  return sorted[sorted.length - 1]!.value;
}
