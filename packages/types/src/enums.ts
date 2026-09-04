/**
 * Core gUSD market-data vocabulary.
 *
 * These classifications distinguish different economic products. The
 * observatory collects broadly across all of them; the settlement
 * methodology decides what is eligible (see @gusd/pricing-engine).
 */

/** Who speaks when a price prints. */
export type SourceType = "principal" | "marketplace" | "reseller" | "aggregator";

/** The economic product being priced. Different tiers are different markets. */
export type PricingTier =
  | "on_demand"
  | "community"
  | "spot"
  | "preemptible"
  | "reserved"
  | "committed";

/**
 * Collection membership and settlement membership are separate concepts.
 * A provider may be collected forever and never settle.
 */
export type ProviderRole =
  | "COLLECTED"
  | "SETTLEMENT_ELIGIBLE"
  | "WATCHDOG_ONLY"
  | "EXCLUDED";

/** How quickly the underlying market information can actually change. */
export type CadenceTier = "FAST" | "MEDIUM" | "SLOW";

/** Explicit failure taxonomy for collection runs. Missing data is not zero. */
export type FailureKind =
  | "network"
  | "parse"
  | "timeout"
  | "rate_limited"
  | "auth_failed"
  | "empty_result"
  | "insufficient_data"
  | "schema_drift"
  | "unknown";

/** Run status recorded per collection run. */
export type RunStatus =
  | "success"
  | "partial"
  | "failed"
  | "skipped"
  | "circuit_open";

/**
 * Publication states for an index candidate. `withheld` is a valid, expected
 * outcome: a withheld price is safer than a fabricated price.
 */
export type IndexStatus =
  | "healthy"
  | "degraded"
  | "stale"
  | "withheld"
  | "frozen";

/** Per-provider statistic used to derive one provider contribution. */
export type ProviderPriceMethod =
  | "median"
  | "volume_weighted_median"
  | "thin_book_holdout";

/** Why an observation/label could not be normalized. */
export type UnmappedReason =
  | "unmapped"
  | "vram_deviation"
  | "fx_missing"
  | "insufficient_data"
  | "invalid_price";
