import { pgEnum } from "drizzle-orm/pg-core";
import type {
  CadenceTier,
  FailureKind,
  IndexStatus,
  PricingTier,
  ProviderPriceMethod,
  ProviderRole,
  RunStatus,
  SourceType,
  WalletKind,
} from "@gusd/types";

/**
 * DB-level enum types mirror the @gusd/types string unions exactly, so a
 * value that survives TypeScript cannot be rejected by Postgres — and a value
 * that bypasses TypeScript cannot reach the tables at all.
 */
export const sourceTypeEnum = pgEnum("source_type", [
  "principal",
  "marketplace",
  "reseller",
  "aggregator",
]);

export const pricingTierEnum = pgEnum("pricing_tier", [
  "on_demand",
  "community",
  "spot",
  "preemptible",
  "reserved",
  "committed",
]);

export const providerRoleEnum = pgEnum("provider_role", [
  "COLLECTED",
  "SETTLEMENT_ELIGIBLE",
  "WATCHDOG_ONLY",
  "EXCLUDED",
]);

export const cadenceTierEnum = pgEnum("cadence_tier", ["FAST", "MEDIUM", "SLOW"]);

export const failureKindEnum = pgEnum("failure_kind", [
  "network",
  "parse",
  "timeout",
  "rate_limited",
  "auth_failed",
  "empty_result",
  "insufficient_data",
  "schema_drift",
  "unknown",
]);

export const runStatusEnum = pgEnum("run_status", [
  "success",
  "partial",
  "failed",
  "skipped",
  "circuit_open",
]);

export const indexStatusEnum = pgEnum("index_status", [
  "healthy",
  "degraded",
  "stale",
  "withheld",
  "frozen",
]);

export const providerPriceMethodEnum = pgEnum("provider_price_method", [
  "median",
  "volume_weighted_median",
  "thin_book_holdout",
]);

export const unmappedStatusEnum = pgEnum("unmapped_status", ["open", "mapped", "ignored"]);

export const walletKindEnum = pgEnum("wallet_kind", ["embedded", "external"]);

// Compile-time guarantee that DB enums and the shared type unions stay in
// lockstep — a drift here fails the build, not production.
type Assert<T extends true> = T;
type _Source = Assert<SourceType extends (typeof sourceTypeEnum.enumValues)[number] ? true : false>;
type _Tier = Assert<PricingTier extends (typeof pricingTierEnum.enumValues)[number] ? true : false>;
type _Role = Assert<
  ProviderRole extends (typeof providerRoleEnum.enumValues)[number] ? true : false
>;
type _Cadence = Assert<
  CadenceTier extends (typeof cadenceTierEnum.enumValues)[number] ? true : false
>;
type _Failure = Assert<
  FailureKind extends (typeof failureKindEnum.enumValues)[number] ? true : false
>;
type _Run = Assert<RunStatus extends (typeof runStatusEnum.enumValues)[number] ? true : false>;
type _Status = Assert<
  IndexStatus extends (typeof indexStatusEnum.enumValues)[number] ? true : false
>;
type _Method = Assert<
  ProviderPriceMethod extends (typeof providerPriceMethodEnum.enumValues)[number] ? true : false
>;
type _WalletKind = Assert<
  WalletKind extends (typeof walletKindEnum.enumValues)[number] ? true : false
>;
