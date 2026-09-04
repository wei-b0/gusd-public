import type { ExclusionReceipt } from "@gusd/types";
import { mad, median } from "./median.js";
import type { JumpConfig, ScreeningConfig } from "./config.js";

/** A candidate provider contribution entering the screens. */
export interface ScreenCandidate {
  providerId: string;
  price: number;
}

export interface MadScreenResult {
  kept: ScreenCandidate[];
  exclusions: ExclusionReceipt[];
  /** Median of the kept prices (the settled level). */
  median: number | null;
  /** 1.4826·MAD/median of the kept prices; 0 when the screen did not arm. */
  dispersion: number;
}

/**
 * Cross-provider MAD screen. One provider = one economic contribution, so
 * flooding offers cannot move the median — but a coordinated tie can set
 * MAD = 0, which is why the ratio-band fallback exists.
 *
 * Does not arm below `minProvidersForScreen`: with too few providers, any
 * screen would just delete information.
 */
export function madScreen(
  candidates: readonly ScreenCandidate[],
  cfg: ScreeningConfig,
): MadScreenResult {
  if (candidates.length === 0) {
    return { kept: [], exclusions: [], median: null, dispersion: 0 };
  }

  const prices = candidates.map((c) => c.price);
  const med = median(prices);
  if (med === null || med <= 0) {
    return { kept: [...candidates], exclusions: [], median: med, dispersion: 0 };
  }

  if (candidates.length < cfg.minProvidersForScreen) {
    const m = mad(prices, med);
    const dispersion = m === null ? 0 : (cfg.madScale * m) / med;
    return { kept: [...candidates], exclusions: [], median: med, dispersion };
  }

  const spread = mad(prices, med);

  // MAD = 0 (or degenerate): every kept-vs-median distance is 0, so σ
  // screening is vacuous and any attacker who can buy a tie owns the
  // screen. Use the ratio band.
  if (spread === null || spread === 0) {
    const kept: ScreenCandidate[] = [];
    const exclusions: ExclusionReceipt[] = [];
    for (const c of candidates) {
      const ratio = c.price / med;
      if (ratio >= 1 / cfg.madZeroRatioBand && ratio <= cfg.madZeroRatioBand) {
        kept.push(c);
      } else {
        exclusions.push({
          providerId: c.providerId,
          reason: "mad_zero_ratio_band",
          detail: `MAD=0 consensus; price ${c.price} outside symmetric ${cfg.madZeroRatioBand}× band around ${med}`,
          value: c.price,
        });
      }
    }
    return { kept, exclusions, median: median(kept.map((k) => k.price)), dispersion: 0 };
  }

  const sigma = cfg.madScale * spread;
  const limit = cfg.sigmaLimit * sigma;
  const kept: ScreenCandidate[] = [];
  const exclusions: ExclusionReceipt[] = [];
  for (const c of candidates) {
    if (Math.abs(c.price - med) <= limit) {
      kept.push(c);
    } else {
      exclusions.push({
        providerId: c.providerId,
        reason: "mad_outlier",
        detail: `|price − median| = ${Math.abs(c.price - med).toFixed(4)} > ${cfg.sigmaLimit}·(${cfg.madScale}·MAD=${sigma.toFixed(4)})`,
        value: c.price,
      });
    }
  }
  const keptPrices = kept.map((k) => k.price);
  const keptMed = median(keptPrices);
  const keptMad = mad(keptPrices, keptMed);
  const dispersion =
    keptMed !== null && keptMed > 0 && keptMad !== null ? (cfg.madScale * keptMad) / keptMed : 0;
  return { kept, exclusions, median: keptMed, dispersion };
}

/**
 * Jump screen: a provider whose price jumped ≥ maxProviderJumpPct vs its own
 * trailing median is excluded — unless at least `minCorroborators` other
 * comparable providers moved ≥ minCorroboratorMovePct (a real market move).
 * Starvation guard: if fewer than minCorroborators+1 providers have a
 * trailing median at all, the screen cannot distinguish manipulation from a
 * cold start, so it stays silent.
 */
export function jumpScreen(
  candidates: readonly (ScreenCandidate & { trailingMedian: number | null })[],
  cfg: JumpConfig,
): ExclusionReceipt[] {
  const comparable = candidates.filter(
    (c) => c.trailingMedian !== null && c.trailingMedian > 0 && c.price > 0,
  );
  if (comparable.length < cfg.minCorroborators + 1) return [];

  const move = (c: (typeof comparable)[number]): number =>
    Math.abs(c.price / c.trailingMedian! - 1);

  const exclusions: ExclusionReceipt[] = [];
  for (const c of comparable) {
    if (move(c) < cfg.maxProviderJumpPct) continue;
    const corroborators = comparable.filter(
      (o) => o.providerId !== c.providerId && move(o) >= cfg.minCorroboratorMovePct,
    );
    if (corroborators.length < cfg.minCorroborators) {
      exclusions.push({
        providerId: c.providerId,
        reason: "jump_screen",
        detail: `price moved ${(move(c) * 100).toFixed(1)}% vs trailing median ${c.trailingMedian!.toFixed(4)} with only ${corroborators.length} corroborator(s) ≥ ${(cfg.minCorroboratorMovePct * 100).toFixed(0)}%`,
        value: c.price,
      });
    }
  }
  return exclusions;
}
