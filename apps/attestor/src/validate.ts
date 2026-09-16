import type {
  BreakerMap,
  CandidateLike,
  PublishableIndexValue,
  PublishViolation,
  ResolvedPublisherConfig,
  Assessment,
} from "./types.js";
import { VIOLATION } from "./types.js";

export interface AssessOptions {
  /** Per-panel resolved thresholds — see resolvePanelThresholds. */
  config: ResolvedPublisherConfig;
  now: Date;
  /** Latest value already published for this gpu — null on a first publish. */
  previousPublishedPrice: number | null;
  /** Oracle-side collector health; absent when the health check is disabled. */
  breakers?: BreakerMap;
}

/**
 * The publisher's independent audit. The oracle already applies publication
 * gates, but the publisher re-derives its own verdict from the candidate's
 * face: a bug or a compromise in the oracle must be visible here. Since the
 * §11 heartbeat policy the verdict does NOT gate publication — every
 * violation is recorded to publish_violations and the value publishes
 * regardless (a current imperfect price beats a stale or absent one for
 * swaps). The only hard stops live in the poller: a null price (nothing
 * exists to publish) and the divergence/heartbeat trigger (gas).
 */
export function assessCandidate(
  candidate: CandidateLike,
  opts: AssessOptions,
): Assessment {
  const { config, now } = opts;
  const violations: PublishViolation[] = [];

  if (candidate.status !== "healthy" && candidate.status !== "degraded") {
    violations.push({
      code: VIOLATION.status,
      detail: `status "${candidate.status}" is not settlement-grade`,
    });
  }

  if (candidate.price === null) {
    violations.push({ code: VIOLATION.price, detail: "candidate has no price" });
  }

  const ageMs = now.getTime() - candidate.computedAt.getTime();
  if (ageMs > config.maxFreshnessMs) {
    violations.push({
      code: VIOLATION.freshness,
      detail: `candidate is ${Math.round(ageMs / 1000)}s old (limit ${Math.round(
        config.maxFreshnessMs / 1000,
      )}s)`,
    });
  }

  if (candidate.methodologyVersion !== config.pinnedMethodologyVersion) {
    violations.push({
      code: VIOLATION.methodology,
      detail: `candidate is ${candidate.methodologyVersion}, publisher is pinned to ${config.pinnedMethodologyVersion}`,
    });
  }

  if (candidate.providersContributing < config.minContributors) {
    violations.push({
      code: VIOLATION.contributors,
      detail: `${candidate.providersContributing} contributing (minimum ${config.minContributors})`,
    });
  }

  if (candidate.dispersion > config.maxDispersion) {
    violations.push({
      code: VIOLATION.dispersion,
      detail: `dispersion ${candidate.dispersion.toFixed(4)} exceeds ${config.maxDispersion}`,
    });
  }

  if (
    candidate.price !== null &&
    candidate.price > 0 &&
    candidate.confidenceLow !== null &&
    candidate.confidenceHigh !== null
  ) {
    const bandWidthPct = (candidate.confidenceHigh - candidate.confidenceLow) / candidate.price;
    if (bandWidthPct > config.maxBandWidthPct) {
      violations.push({
        code: VIOLATION.band,
        detail: `band width ${(bandWidthPct * 100).toFixed(1)}% of price exceeds ${(
          config.maxBandWidthPct * 100
        ).toFixed(1)}%`,
      });
    }
  }

  if (opts.previousPublishedPrice !== null && candidate.price !== null) {
    const prev = opts.previousPublishedPrice;
    if (prev > 0) {
      const jumpPct = Math.abs(candidate.price - prev) / prev;
      if (jumpPct > config.maxJumpPct) {
        violations.push({
          code: VIOLATION.jump,
          detail: `price move ${(jumpPct * 100).toFixed(1)}% vs last published ${prev} exceeds ${(
            config.maxJumpPct * 100
          ).toFixed(1)}% — manual review required`,
        });
      }
    }
  }

  // Contributor source health: if the oracle reports a majority of this
  // candidate's contributors with open breakers, the value was computed from
  // sources that were failing at validation time.
  if (opts.breakers !== undefined) {
    const open = candidate.contributors.filter(
      (c) => opts.breakers?.get(c.providerId) === true,
    ).length;
    if (open * 2 > candidate.contributors.length) {
      violations.push({
        code: VIOLATION.sources,
        detail: `${open} of ${candidate.contributors.length} contributing providers have open breakers`,
      });
    }
  }

  if (candidate.price === null) return { violations, value: null };

  const value: PublishableIndexValue = {
    candidateId: candidate.id,
    gpuId: candidate.gpuId,
    panelId: candidate.panelId,
    price: candidate.price,
    confidenceLow: candidate.confidenceLow,
    confidenceHigh: candidate.confidenceHigh,
    status: candidate.status,
    methodologyVersion: candidate.methodologyVersion,
    calcHash: candidate.calcHash,
    computedAt: candidate.computedAt.toISOString(),
  };
  return { violations, value };
}
