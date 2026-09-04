import type {
  ExclusionReceipt,
  PricingTier,
  ProviderHoldout,
  ProviderPriceResult,
} from "@gusd/types";
import type { GpuSku } from "@gusd/gpu-catalog";
import type { AggregationConfig } from "./config.js";
import { median, weightedMedian } from "./median.js";
import { round4 } from "@gusd/types";

/**
 * Per-provider aggregation: many rows in, exactly one economic contribution
 * out (or a holdout with a reason — never a guess).
 *
 * Two paths:
 *  - order book (rows carry machine/host identity): skip bids, reject
 *    missing/out-of-range gpu counts (never default them), arithmetic
 *    tripwire, plausible-band check, cheapest-per-machine dedup, depth
 *    floors, then a volume-weighted median weighted by gpu count;
 *  - rate card (per-GPU list prices): tier filter, plausible-band check,
 *    plain median.
 *
 * An order book that fails its depth floors is a `thin_book_holdout`,
 * not a number.
 */

/** A normalized observation as it enters aggregation. */
export interface AggregationObservation {
  offerId: string | null;
  machineId: string | null;
  hostId: string | null;
  /** USD per GPU-hour, already unit- and FX-normalized. */
  usdPerGpuHour: number;
  /** The provider's own stated total for the row, when published. */
  rawTotalUsdPerHour: number | null;
  pricingTier: PricingTier | null;
  gpuCount: number | null;
  isBid: boolean;
  available: boolean | null;
  region: string | null;
  observedAt: Date;
}

export interface AggregateProviderPriceInput {
  providerId: string;
  gpu: GpuSku;
  panelId: string;
  observations: readonly AggregationObservation[];
  /**
   * Provider-level executable flag from the registry (order books with real
   * inventory vs list prices). The result carries it through verbatim —
   * weights are keyed on it downstream.
   */
  executable: boolean;
  coverageGap: boolean;
  config: AggregationConfig;
  windowStart: Date;
  windowEnd: Date;
  computedAt: Date;
  methodologyVersion: string;
}

/** Which aggregation path applies, derived from row identity data. */
export function aggregationPath(
  observations: readonly AggregationObservation[],
): "order_book" | "rate_card" {
  return observations.some((o) => o.machineId !== null || o.hostId !== null)
    ? "order_book"
    : "rate_card";
}

export function aggregateProviderPrice(
  input: AggregateProviderPriceInput,
): ProviderPriceResult {
  const { config } = input;
  const path = aggregationPath(input.observations);
  const [bandLo, bandHi] = input.gpu.plausibleBandUsdPerGpuHour;

  const exclusions: ExclusionReceipt[] = [];
  const flags = {
    coverageGap: input.coverageGap,
    dedupDroppedCount: 0,
    bidOffersSkipped: 0,
    arithmeticMismatches: 0,
    outOfRangeGpuCounts: 0,
    outOfBandCount: 0,
  };

  const exclude = (obs: AggregationObservation, reason: string, detail: string): void => {
    exclusions.push({
      providerId: input.providerId,
      reason,
      detail,
      value: obs.usdPerGpuHour,
    });
  };

  /** Returns null when the row must not be priced. */
  const screenRow = (obs: AggregationObservation, requireGpuCount: boolean): boolean => {
    if (obs.available === false) {
      exclude(obs, "unavailable", "provider marked the offer unavailable");
      return false;
    }
    if (path === "order_book") {
      if (obs.isBid) {
        flags.bidOffersSkipped += 1;
        exclude(obs, "bid_offer", "bid prices are intentions, not executable offers");
        return false;
      }
      const n = obs.gpuCount;
      if (requireGpuCount && (n === null || n < config.gpuCountMin || n > config.gpuCountMax)) {
        flags.outOfRangeGpuCounts += 1;
        exclude(
          obs,
          "gpu_count_out_of_range",
          `gpuCount ${n === null ? "missing" : n} outside [${config.gpuCountMin}, ${config.gpuCountMax}] — never defaulted`,
        );
        return false;
      }
    }
    if (obs.usdPerGpuHour < bandLo || obs.usdPerGpuHour > bandHi) {
      flags.outOfBandCount += 1;
      exclude(
        obs,
        "out_of_band",
        `price ${obs.usdPerGpuHour} outside plausible band [${bandLo}, ${bandHi}] for ${input.gpu.id}`,
      );
      return false;
    }
    if (
      path === "order_book" &&
      obs.rawTotalUsdPerHour !== null &&
      obs.gpuCount !== null &&
      obs.gpuCount > 0
    ) {
      const expected = round4(obs.usdPerGpuHour) * obs.gpuCount;
      const total = obs.rawTotalUsdPerHour;
      if (Math.abs(expected - total) > config.arithmeticTolerancePerGpu * obs.gpuCount) {
        flags.arithmeticMismatches += 1;
        exclude(
          obs,
          "arithmetic_mismatch",
          `perGpu×n = ${expected.toFixed(4)} but provider says total ${total.toFixed(4)}`,
        );
        return false;
      }
    }
    return true;
  };

  if (path === "order_book") {
    // Pass 1: screens.
    const screened: { obs: AggregationObservation; index: number }[] = [];
    for (let i = 0; i < input.observations.length; i++) {
      const obs = input.observations[i]!;
      if (screenRow(obs, true)) screened.push({ obs, index: i });
    }

    // Pass 2: cheapest per machine (fallback host, fallback row) — the same
    // machine listed twice contributes once, at its cheapest per-GPU price.
    const byKey = new Map<string, { obs: AggregationObservation; index: number }>();
    for (const entry of screened) {
      const key =
        entry.obs.machineId ?? entry.obs.hostId ?? entry.obs.offerId ?? `row:${entry.index}`;
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, entry);
      } else {
        const challenger = entry.obs.usdPerGpuHour;
        const incumbent = existing.obs.usdPerGpuHour;
        if (challenger < incumbent) byKey.set(key, entry);
        flags.dedupDroppedCount += 1;
      }
    }

    // Pass 3: depth floors. If the source publishes no host ids at all, each
    // machine is assumed to be its own host (documented limitation). If only
    // some rows carry host ids, only real host ids count — fail closed.
    const book = [...byKey.values()];
    const machines = new Set(book.map((b) => b.obs.machineId ?? `dedup:${b.index}`));
    const hostIds = book.map((b) => b.obs.hostId).filter((h): h is string => h !== null);
    const hosts = hostIds.length === 0 ? machines : new Set(hostIds);
    const depthOk =
      machines.size >= config.minMachinesForBook && hosts.size >= config.minHostsForBook;

    const base = () => ({
      providerId: input.providerId,
      gpuId: input.gpu.id,
      panelId: input.panelId,
      executable: input.executable,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      computedAt: input.computedAt,
      methodologyVersion: input.methodologyVersion,
      receipts: { contributions: [], exclusions, flags },
    });

    if (book.length === 0) {
      const holdout: ProviderHoldout = {
        providerId: input.providerId,
        reason: input.observations.length === 0 ? "no_usd_observations" : "all_filtered",
      };
      return {
        ...base(),
        price: null,
        method: "volume_weighted_median",
        sampleSize: 0,
        params: { path, ...depthParams(config, 0, 0) },
        receipts: { ...base().receipts, holdout },
      };
    }

    if (!depthOk) {
      return {
        ...base(),
        price: null,
        method: "thin_book_holdout",
        sampleSize: book.length,
        params: { path, ...depthParams(config, machines.size, hosts.size) },
        receipts: {
          ...base().receipts,
          holdout: {
            providerId: input.providerId,
            reason: "thin_book",
            detail: `${machines.size} machine(s), ${hosts.size} host(s) below floors (${config.minMachinesForBook}/${config.minHostsForBook})`,
          },
        },
      };
    }

    const weighted = book.map((b) => ({
      value: b.obs.usdPerGpuHour,
      weight: Math.min(
        Math.max(b.obs.gpuCount ?? 1, 1),
        Math.min(config.gpuCountMax, 16),
      ),
    }));
    const price = weightedMedian(weighted);
    return {
      ...base(),
      price: price === null ? null : round4(price),
      method: "volume_weighted_median",
      sampleSize: book.length,
      params: { path, ...depthParams(config, machines.size, hosts.size) },
      receipts: base().receipts,
    };
  }

  // Rate-card path.
  const kept: number[] = [];
  for (const obs of input.observations) {
    if (!screenRow(obs, false)) continue;
    if (
      obs.pricingTier === null ||
      !config.eligibleTiers.includes(obs.pricingTier)
    ) {
      exclude(
        obs,
        "tier_not_eligible",
        `tier ${obs.pricingTier ?? "unknown"} not in eligible set [${config.eligibleTiers.join(", ")}]`,
      );
      continue;
    }
    kept.push(obs.usdPerGpuHour);
  }

  const base = () => ({
    providerId: input.providerId,
    gpuId: input.gpu.id,
    panelId: input.panelId,
    executable: input.executable,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    computedAt: input.computedAt,
    methodologyVersion: input.methodologyVersion,
    receipts: { contributions: [], exclusions, flags },
  });

  const med = median(kept);
  if (med === null) {
    return {
      ...base(),
      price: null,
      method: "median",
      sampleSize: 0,
      params: { path, eligibleTiers: [...config.eligibleTiers] },
      receipts: {
        ...base().receipts,
        holdout: {
          providerId: input.providerId,
          reason: input.observations.length === 0 ? "no_usd_observations" : "all_filtered",
        },
      },
    };
  }
  return {
    ...base(),
    price: round4(med),
    method: "median",
    sampleSize: kept.length,
    params: { path, eligibleTiers: [...config.eligibleTiers] },
    receipts: base().receipts,
  };
}

function depthParams(
  config: AggregationConfig,
  machines: number,
  hosts: number,
): Record<string, unknown> {
  return {
    minMachinesForBook: config.minMachinesForBook,
    minHostsForBook: config.minHostsForBook,
    arithmeticTolerancePerGpu: config.arithmeticTolerancePerGpu,
    gpuCountMin: config.gpuCountMin,
    gpuCountMax: config.gpuCountMax,
    observedMachines: machines,
    observedHosts: hosts,
  };
}
