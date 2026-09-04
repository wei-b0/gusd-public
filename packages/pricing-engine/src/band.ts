import { round4 } from "@gusd/types";

/**
 * Confidence band via vote-IQM: each contributing provider casts three votes
 * at p−σ, p, p+σ (σ = its own historical dispersion, floored at the config
 * floor). The index value is the weighted mean of the central third of all
 * votes; the band half-width is max(value − q25, q75 − value) over the full
 * vote distribution. A provider whose own history is volatile gets wider
 * votes and therefore less leverage over the central third.
 */
export interface ConfidenceVote {
  providerId: string;
  price: number;
  /** Historical σ as a fraction of price (already floored by the caller). */
  sigma: number;
  weight: number;
}

export interface ConfidenceBand {
  value: number;
  low: number;
  high: number;
}

interface VotePoint {
  value: number;
  weight: number;
}

export function confidenceBand(votes: readonly ConfidenceVote[]): ConfidenceBand | null {
  if (votes.length === 0) return null;

  const points: VotePoint[] = [];
  for (const v of votes) {
    const s = Math.max(0, v.sigma);
    points.push({ value: v.price * (1 - s), weight: v.weight });
    points.push({ value: v.price, weight: v.weight });
    points.push({ value: v.price * (1 + s), weight: v.weight });
  }
  points.sort((a, b) => a.value - b.value);
  const total = points.reduce((acc, p) => acc + p.weight, 0);
  if (total <= 0) return null;

  // Central-third weighted mean: each point's slot is [cumBefore, cumAfter]
  // on the total-weight line; it contributes in proportion to its overlap
  // with the window [W/3, 2W/3].
  const windowLo = total / 3;
  const windowHi = (2 * total) / 3;
  let cum = 0;
  let weightedSum = 0;
  let windowWeight = 0;
  for (const p of points) {
    const slotLo = cum;
    cum += p.weight;
    const overlap = Math.min(cum, windowHi) - Math.max(slotLo, windowLo);
    if (overlap > 0) {
      weightedSum += p.value * overlap;
      windowWeight += overlap;
    }
  }
  if (windowWeight <= 0) return null;
  const value = weightedSum / windowWeight;

  // Weighted quantiles over the full vote distribution.
  const quantile = (q: number): number => {
    const target = q * total;
    let c = 0;
    for (const p of points) {
      c += p.weight;
      if (c >= target) return p.value;
    }
    return points[points.length - 1]!.value;
  };
  const q25 = quantile(0.25);
  const q75 = quantile(0.75);

  const halfWidth = Math.max(value - q25, q75 - value, 0);
  return {
    value: round4(value),
    low: round4(value - halfWidth),
    high: round4(value + halfWidth),
  };
}
