import type { IndexStatus } from "@gusd/types";

/**
 * The candidate fields the attestor reads off the oracle's index_candidates.
 */
export interface CandidateLike {
  id: string;
  gpuId: string;
  panelId: string;
  price: number | null;
  confidenceLow: number | null;
  confidenceHigh: number | null;
  status: IndexStatus;
  providersContributing: number;
  dispersion: number;
  methodologyVersion: string;
  calcHash: string;
  computedAt: Date;
  contributors: readonly { providerId: string }[];
}

export interface PublishViolation {
  code: string;
  detail: string;
}

export interface AttestorConfig {
  /** Candidates naming another methodology version are annotated — the pin keys the audit to one methodology. */
  readonly pinnedMethodologyVersion: string;
  /**
   * Absolute contributor floor across all panels, or null to use the pinned
   * methodology's per-panel quorum alone. When set, it can only tighten
   * (max with the panel quorum) — never relax below the methodology.
   * Annotation threshold — flagged candidates still attest.
   */
  readonly minContributors: number | null;
  /**
   * Absolute dispersion ceiling, or null to use the methodology's per-panel
   * cap alone. When set, it can only tighten (min against the panel cap).
   * Annotation threshold — flagged candidates still attest.
   */
  readonly maxDispersion: number | null;
  /** Candidate age beyond this is annotated as stale (attestation still proceeds within the floor). */
  readonly maxFreshnessMs: number;
  /** |Δ|/last report above this is annotated for manual review (attestation still proceeds). */
  readonly maxJumpPct: number;
  /**
   * Confidence band width as a fraction of price, or null to use the panel's
   * dispersion cap. When set, it can only tighten. The band is a second
   * measure of the same spread the methodology's dispersion gate bounds, so
   * absent an explicit operator floor the methodology's own tolerance applies.
   * Annotation threshold — flagged candidates still attest.
   */
  readonly maxBandWidthPct: number | null;
}

/** AttestorConfig with the per-panel methodology values merged in — what the
 *  validator evaluates against (never the raw config, which may carry nulls). */
export type ResolvedAttestorConfig = AttestorConfig & {
  minContributors: number;
  maxDispersion: number;
  maxBandWidthPct: number;
};

/** slug → breakerOpen, as reported by the oracle's /v1/health. */
export type BreakerMap = ReadonlyMap<string, boolean>;

/**
 * The audit verdict for one candidate. Violations are annotations — recorded
 * to publish_violations, never attestation blockers (the pull-oracle posture:
 * trades need a report for the current epoch, and an imperfect attested
 * figure beats a stale or absent one — the violation rows join reports on
 * candidate_id so the audit sees exactly what shipped despite a flag).
 * `value` is null only when the candidate carries no price at all — there is
 * nothing honest to attest.
 */
export interface Assessment {
  violations: PublishViolation[];
  value: AttestableIndexValue | null;
}

/**
 * The audited candidate fields a Report is built from: only (gpuId, price,
 * observedAt ← computedAt, calcHash) reach the signature — status and
 * confidence bands ride the DB for audit. `calcHash` binds the report to the
 * byte-stable identity of the engine run that produced the price.
 */
export interface AttestableIndexValue {
  candidateId: string;
  gpuId: string;
  panelId: string;
  price: number;
  confidenceLow: number | null;
  confidenceHigh: number | null;
  status: IndexStatus;
  methodologyVersion: string;
  calcHash: string;
  computedAt: string;
}

/** Violation codes — stable identifiers, safe to alarm on. */
export const VIOLATION = {
  status: "not_publishable_status",
  price: "missing_price",
  freshness: "stale_candidate",
  methodology: "methodology_mismatch",
  contributors: "insufficient_contributors",
  dispersion: "excess_dispersion",
  band: "excess_band_width",
  jump: "jump_requires_manual",
  sources: "contributor_sources_unhealthy",
  healthUnknown: "source_health_unavailable",
} as const;
