import type { IndexStatus } from "@gusd/types";

/**
 * The value handed to a PublisherTarget: the audited candidate, exactly what
 * lands in the ledger. Only (gpuId, price, updatedAt) reach the chain —
 * status and band ride the DB ledger for audit. The publisher holds no key
 * material — a real target would sign inside its implementation.
 */
export interface PublishableIndexValue {
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

/** One destination for published values (mock first, chain later). */
export interface PublisherTarget {
  readonly name: string;
  publish(value: PublishableIndexValue): Promise<{ txRef: string }>;
}

/** The candidate fields the publisher reads off the oracle's index_candidates. */
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

export interface PublisherConfig {
  /** Candidates naming another methodology version are annotated — the pin keys the audit to one methodology. */
  readonly pinnedMethodologyVersion: string;
  /**
   * Absolute contributor floor across all panels, or null to use the pinned
   * methodology's per-panel quorum alone. When set, it can only tighten
   * (max with the panel quorum) — never relax below the methodology.
   * Annotation threshold — flagged candidates still publish.
   */
  readonly minContributors: number | null;
  /**
   * Absolute dispersion ceiling, or null to use the methodology's per-panel
   * cap alone. When set, it can only tighten (min against the panel cap).
   * Annotation threshold — flagged candidates still publish.
   */
  readonly maxDispersion: number | null;
  /** Candidate age beyond this is annotated as stale (publication still proceeds). */
  readonly maxFreshnessMs: number;
  /** |Δ|/previous-published above this is annotated for manual review (publication still proceeds — §11). */
  readonly maxJumpPct: number;
  /**
   * Confidence band width as a fraction of price, or null to use the panel's
   * dispersion cap. When set, it can only tighten. The band is a second
   * measure of the same spread the methodology's dispersion gate bounds, so
   * absent an explicit operator floor the methodology's own tolerance applies.
   * Annotation threshold — flagged candidates still publish.
   */
  readonly maxBandWidthPct: number | null;
  /**
   * PROTOCOL.md §11 deviation publication: |candidate − last published| as a
   * fraction of the last published price. Below it (and before the heartbeat)
   * the on-chain figure is already current and the tx is suppressed — that is
   * the gas saver. 0 publishes every fresh candidate.
   */
  readonly minDeviationPct: number;
  /**
   * PROTOCOL.md §11 heartbeat: republish even without deviation after this
   * long, so on-chain updatedAt never goes stale while the price plateaus.
   */
  readonly heartbeatMs: number;
}

/** PublisherConfig with the per-panel methodology values merged in — what the
 *  validator evaluates against (never the raw config, which may carry nulls). */
export type ResolvedPublisherConfig = PublisherConfig & {
  minContributors: number;
  maxDispersion: number;
  maxBandWidthPct: number;
};

/** slug → breakerOpen, as reported by the oracle's /v1/health. */
export type BreakerMap = ReadonlyMap<string, boolean>;

/**
 * The audit verdict for one candidate. Violations are annotations — recorded
 * to publish_violations, never publication blockers (the §11 posture: swaps
 * need a current price; an imperfect published figure beats a stale or
 * absent one, and the violation rows join publications on candidate_id so
 * the audit sees exactly what shipped despite a flag). `value` is null only
 * when the candidate carries no price at all — there is nothing to publish.
 */
export interface Assessment {
  violations: PublishViolation[];
  value: PublishableIndexValue | null;
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
