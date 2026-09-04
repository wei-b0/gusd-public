/**
 * Iterative weight cap. No provider may hold more than `cap` of total weight
 * even after capping removes weight from it. The update rule
 *
 *     w_i ← cap · (Σ − w_i) / (1 − cap)
 *
 * assigns the provider `cap` of everyone else's weight, which is the unique
 * fixed point of that constraint. Iterates at most 20 times; the iteration
 * order is the input order, so the same input always yields the same output.
 */
export interface WeightItem {
  providerId: string;
  weight: number;
}

export interface CappedWeight {
  providerId: string;
  weightBeforeCap: number;
  weightAfterCap: number;
}

export function capWeights(items: readonly WeightItem[], cap: number): CappedWeight[] {
  const base = items.map((i) => i.weight);
  const weights = [...base];
  // 60 iterations: each pass shrinks the excess share geometrically
  // (~×0.54 per re-cap), so this converges to the cap far below 1e-9.
  for (let iter = 0; iter < 60; iter++) {
    const total = weights.reduce((a, w) => a + w, 0);
    if (total <= 0) break;
    const maxW = Math.max(...weights);
    if (maxW <= cap * total + Number.EPSILON * Math.max(1, total)) break;
    const idx = weights.indexOf(maxW);
    weights[idx] = (cap * (total - maxW)) / (1 - cap);
  }
  // Infeasibility guard: below ⌈1/cap⌉ providers the cap is mathematically
  // impossible (two providers always leave someone ≥ 50%), and the iteration
  // then drives all weights toward zero without ever satisfying the
  // constraint. If capping failed to improve the worst share, leave the
  // weights undistorted — the index-level min_providers gate blocks such
  // books from publishing anyway.
  const finalTotal = weights.reduce((a, w) => a + w, 0);
  const baseTotal = base.reduce((a, w) => a + w, 0);
  const improved =
    finalTotal > 0 &&
    baseTotal > 0 &&
    Math.max(...weights) / finalTotal < Math.max(...base) / baseTotal - 1e-9;
  const out = improved ? weights : base;
  return items.map((item, i) => ({
    providerId: item.providerId,
    weightBeforeCap: item.weight,
    weightAfterCap: out[i]!,
  }));
}
