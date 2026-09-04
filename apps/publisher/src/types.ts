import type { IndexStatus } from "@gusd/types";

/**
 * The value handed to a PublisherTarget: fully validated, exactly what lands
 * on-chain. The publisher holds no key material — a real target would sign
 * inside its implementation.
 */
export interface PublishableIndexValue {
  candidateId: string;
  gpuId: string;
  panelId: string;
  price: number;
  confidenceLow: number | null;
  confidenceHigh: number | null;
  status: "healthy" | "degraded";
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
  /** Candidates under any other methodology version are refused — no silent drift. */
  readonly pinnedMethodologyVersion: string;
  readonly minContributors: number;
  readonly maxDispersion: number;
  /** Candidate age limit — a stale candidate is re-derivable, never publishable. */
  readonly maxFreshnessMs: number;
  /** |Δ|/previous-published above this needs a human, not an auto-publish. */
  readonly maxJumpPct: number;
  /** Confidence band width as a fraction of price. */
  readonly maxBandWidthPct: number;
}

/** slug → breakerOpen, as reported by the oracle's /v1/health. */
export type BreakerMap = ReadonlyMap<string, boolean>;

export type ValidationResult =
  | { ok: true; value: PublishableIndexValue }
  | { ok: false; violations: PublishViolation[] };

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
