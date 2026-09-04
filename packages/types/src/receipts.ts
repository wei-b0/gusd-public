import type { IndexStatus, ProviderPriceMethod } from "./enums.js";

/**
 * Audit receipts. Every published price must be reconstructable: these
 * receipt shapes are embedded in provider_prices and index_candidates rows.
 */

/** A single published gate evaluation. */
export interface Gate {
  name: string;
  passed: boolean;
  observed: string | number | null;
  threshold: string | number | null;
  reason?: string;
}

/** Why a provider contribution was excluded from a computation. */
export interface ExclusionReceipt {
  providerId: string;
  reason: string;
  detail?: string;
  /** The value that was excluded, when one existed. */
  value?: number | null;
}

/** Why a provider price was held out before the index stage (aggregation-level). */
export interface ProviderHoldout {
  providerId: string;
  reason: "thin_book" | "no_usd_observations" | "all_filtered";
  detail?: string;
}

/** A contributing provider, exactly as it entered the aggregation. */
export interface ContributionReceipt {
  providerId: string;
  price: number;
  weightBeforeCap: number;
  weightAfterCap: number;
  executable: boolean;
  sampleSize: number;
  method: ProviderPriceMethod;
  sigma: number | null;
}

/** Per-provider aggregation result (one economic contribution per provider). */
export interface ProviderPriceResult {
  providerId: string;
  gpuId: string;
  panelId: string;
  price: number | null;
  executable: boolean;
  method: ProviderPriceMethod;
  sampleSize: number;
  windowStart: Date;
  windowEnd: Date;
  computedAt: Date;
  methodologyVersion: string;
  params: Record<string, unknown>;
  receipts: {
    contributions: ContributionReceipt[];
    exclusions: ExclusionReceipt[];
    holdout?: ProviderHoldout;
    flags: {
      coverageGap: boolean;
      dedupDroppedCount: number;
      bidOffersSkipped: number;
      arithmeticMismatches: number;
      outOfRangeGpuCounts: number;
      outOfBandCount: number;
    };
  };
}

/** The full, auditable result of an index computation. */
export interface IndexResult {
  gpuId: string;
  panelId: string;
  price: number | null;
  confidenceLow: number | null;
  confidenceHigh: number | null;
  dispersion: number;
  status: IndexStatus;
  gates: Gate[];
  contributors: ContributionReceipt[];
  exclusions: ExclusionReceipt[];
  providersObserved: number;
  providersContributing: number;
  methodologyVersion: string;
  calcParams: Record<string, unknown>;
  windowStart: Date;
  windowEnd: Date;
  computedAt: Date;
  /** canonicalJson of the result minus volatile fields; hashed to calcHash by the caller. */
  receipt: string;
}
