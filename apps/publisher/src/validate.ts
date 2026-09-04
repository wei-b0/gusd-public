import type {
  BreakerMap,
  CandidateLike,
  PublishableIndexValue,
  PublishViolation,
  PublisherConfig,
  ValidationResult,
} from "./types.js";
import { VIOLATION } from "./types.js";

export interface ValidateOptions {
  config: PublisherConfig;
  now: Date;
  /** Latest value already published for this gpu — null on a first publish. */
  previousPublishedPrice: number | null;
  /** Oracle-side collector health; absent when the health check is disabled. */
  breakers?: BreakerMap;
}

/**
 * The publisher's independent gate. The oracle already applies publication
 * gates, but the publisher re-derives its own verdict from the candidate's
 * face: a bug or a compromise in the oracle must not flow through to the
 * chain unchallenged. All violations are collected — the rejection record is
 * the diagnosis.
 */
export function validateCandidate(
  candidate: CandidateLike,
  opts: {
    config: PublisherConfig;
    now: Date;
    previousPublishedPrice: number | null;
    breakers?: BreakerMap;
  },
): ValidationResult {
  const { config, now } = opts;
  const violations: PublishViolation[] = [];

  if (candidate.status !== "healthy" && candidate.status !== "degraded") {
    violations.push({
      code: VIOLATION.status,
      detail: `status "${candidate.status}" is not publishable`,
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

  if (violations.length > 0) return { ok: false, violations };

  const value: PublishableIndexValue = {
    candidateId: candidate.id,
    gpuId: candidate.gpuId,
    panelId: candidate.panelId,
    price: candidate.price as number,
    confidenceLow: candidate.confidenceLow,
    confidenceHigh: candidate.confidenceHigh,
    // Narrowed by the status violation above; TS can't see through the
    // accumulator.
    status: candidate.status as "healthy" | "degraded",
    methodologyVersion: candidate.methodologyVersion,
    calcHash: candidate.calcHash,
    computedAt: candidate.computedAt.toISOString(),
  };
  return { ok: true, value };
}
