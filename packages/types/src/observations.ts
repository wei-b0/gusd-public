import type { FailureKind, PricingTier, SourceType } from "./enums.js";

/**
 * Stage 1: exactly what the provider published, before any interpretation.
 * Raw market data is immutable. The provider's own GPU label, its own price
 * figure, its own currency and unit are preserved verbatim alongside the raw
 * payload slice that produced the row.
 */
export interface RawObservationInput {
  providerSlug: string;
  sourceType: SourceType;

  /** The provider's own GPU label, unmodified. */
  rawGpuLabel: string;

  /** The provider's published numeric price, null when published without one. */
  rawPrice: number | null;

  /** ISO 4217 code as published (e.g. "USD", "EUR"); "UNKNOWN" if not stated. */
  rawCurrency: string;

  /** Provider's unit vocabulary, e.g. "usd_per_gpu_hr", "usd_per_instance_hr", "cents_per_hour". */
  rawUnit: string;

  /** GPU count as stated by the provider; never defaulted. */
  gpuCount: number | null;

  region: string | null;
  pricingTier: PricingTier | null;
  observedAt: Date;
  sourceUrl: string | null;

  /**
   * The provider's own identifier for this row (offer id, instance type name,
   * SKU code) when one exists. Feeds the obsFingerprint dedup key so a retried
   * or replayed batch cannot double-insert.
   */
  sourceId: string | null;

  /** The minimal slice of the provider response backing this row (JSONB-stored). */
  rawPayload: unknown;

  // --- provider-published book fields (copied through, never derived) ---

  /** Provider's own availability flag; null when the source publishes none. */
  available?: boolean | null;
  /** Provider's own offer id, when published. */
  offerId?: string | null;
  /** Marketplace machine identity (e.g. Vast machine_id), when published. */
  machineId?: string | null;
  /** Marketplace host identity, when published. */
  hostId?: string | null;
  /** True when the row is a bid/interruptible intention rather than an executable offer. */
  isBid?: boolean;
}

/**
 * Stage 2: the normalized, comparable form. Always linked back to its raw
 * observation. Rows that cannot be normalized produce an UnmappedRecord and
 * no NormalizedObservation — nothing is guessed.
 */
export interface NormalizedObservationInput {
  providerSlug: string;
  sourceType: SourceType;

  /** Canonical catalog id; null only in UnmappedRecord. */
  gpuId: string;

  usdPerGpuHour: number;
  pricingTier: PricingTier;

  gpuCount: number | null;
  region: string | null;
  available: boolean | null;

  /** Marketplace identity fields used for machine-level dedup. */
  offerId: string | null;
  machineId: string | null;
  hostId: string | null;

  /** Instance-level total in USD/hour when the provider publishes one (drives the arithmetic tripwire). */
  rawTotalUsdPerHour: number | null;

  /** Is this offer flagged as a bid/spot-interruptible offer (e.g. Vast `is_bid`)? */
  isBid: boolean;

  observedAt: Date;

  /** Assigned at persist time; links to raw_observations.id. */
  rawObservationId: string;

  /** FX rate applied to rawCurrency (USD per unit); 1.0 when the raw currency was USD. */
  fxRateUsed?: number | null;
  /** Rate date of the applied FX quote (ISO date); null when none was applied. */
  fxRateDate?: string | null;
  /** Normalizer version that produced this row (audit). */
  normalizationVersion?: string;
}

/** A raw observation that could not be normalized. Parked, counted, never guessed. */
export interface UnmappedRecord {
  rawObservation: RawObservationInput;
  reason: "unmapped" | "vram_deviation" | "fx_missing" | "insufficient_data" | "invalid_price";
  detail: string;
}

/** Result of a successful collector run. Collectors never write to the DB. */
export interface CollectionResult {
  status: "success";
  rawObservations: RawObservationInput[];
  /** Book-shape metadata for order-book sources (truncation detection). */
  pagination?: {
    fetchedAsc: boolean;
    fetchedDesc: boolean;
    coverageGap: boolean;
  };
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

/** Minimal logger surface so packages avoid a pino dependency. */
export interface Logger {
  debug(msg: string, obj?: unknown): void;
  info(msg: string, obj?: unknown): void;
  warn(msg: string, obj?: unknown): void;
  error(msg: string, obj?: unknown): void;
}

export type { FailureKind, PricingTier, SourceType };
