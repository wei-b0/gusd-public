import type {
  ContributionReceipt,
  ExclusionReceipt,
  IndexStatus,
  ProviderPriceResult,
  ProviderRole,
} from "@gusd/types";
import { canonicalJson, round4 } from "@gusd/types";
import type { GpuSku } from "@gusd/gpu-catalog";
import { effectiveConfigFor } from "./config.js";
import type { MethodologyConfig } from "./config.js";
import { confidenceBand, type ConfidenceBand } from "./band.js";
import { evaluateGates } from "./gates.js";
import { capWeights } from "./weights.js";
import { jumpScreen, madScreen } from "./screen.js";

/**
 * computeIndex — the pure, deterministic settlement computation. No network,
 * no DB, no clock, no randomness: `now` is injected, the same input always
 * yields a byte-identical receipt. It never interpolates, never guesses, and
 * treats `withheld` as a perfectly good answer.
 */
export interface ProviderStat {
  /** Historical σ of this provider's own prices, as a fraction. Null = unknown. */
  sigma: number | null;
  /** Time of the provider's most recent observation behind its price. */
  lastPriceAt: Date | null;
  /** Median of the provider's own recent prices — the jump-screen baseline. */
  trailingMedian: number | null;
}

export interface PriorCandidate {
  price: number;
  computedAt: Date;
  candidateId: string;
}

export interface IndexInput {
  gpu: GpuSku;
  panelId: string;
  providerPrices: readonly ProviderPriceResult[];
  /** The engine filters settlement eligibility itself — watchdog data cannot leak. */
  providerRoles: ReadonlyMap<string, ProviderRole>;
  providerStats: ReadonlyMap<string, ProviderStat>;
  prior: PriorCandidate | null;
  now: Date;
  windowStart: Date;
  windowEnd: Date;
  config: MethodologyConfig;
}

export function computeIndex(input: IndexInput): import("@gusd/types").IndexResult {
  // Panels may run on a relaxed gate/dispersion patch (thin SKUs priced by
  // fewer sources). Everything downstream — screens, weights, band, gates —
  // sees the effective config, and the receipt records it, so a replay from
  // the stored methodology row derives the identical computation.
  const config = effectiveConfigFor(input.config, input.panelId);
  const exclusions: ExclusionReceipt[] = [];

  // 1. Settlement eligibility: collection breadth ≠ settlement membership.
  const eligible = input.providerPrices.filter(
    (p) => input.providerRoles.get(p.providerId) === "SETTLEMENT_ELIGIBLE",
  );
  for (const p of input.providerPrices) {
    if (input.providerRoles.get(p.providerId) !== "SETTLEMENT_ELIGIBLE" && p.price !== null) {
      exclusions.push({
        providerId: p.providerId,
        reason: "role_not_settlement_eligible",
        detail: `role ${String(input.providerRoles.get(p.providerId) ?? "unknown")}`,
        value: p.price,
      });
    }
  }

  const observed = eligible.filter((p) => p.price !== null);
  const providersObserved = observed.length;
  for (const p of eligible) {
    if (p.price !== null) continue;
    exclusions.push({
      providerId: p.providerId,
      reason: "provider_held_out",
      detail: p.receipts.holdout
        ? `${p.receipts.holdout.reason}${p.receipts.holdout.detail ? `: ${p.receipts.holdout.detail}` : ""}`
        : "no price produced",
    });
  }

  // 2. Jump screen against each provider's own trailing median.
  const jumpCandidates = observed.map((p) => ({
    providerId: p.providerId,
    price: p.price!,
    trailingMedian: input.providerStats.get(p.providerId)?.trailingMedian ?? null,
  }));
  exclusions.push(...jumpScreen(jumpCandidates, config.jump));
  const jumpedIds = new Set(exclusions.filter((e) => e.reason === "jump_screen").map((e) => e.providerId));
  const postJump = observed.filter((p) => !jumpedIds.has(p.providerId));

  // 3. Cross-provider MAD screen (arms at ≥ minProvidersForScreen).
  const screen = madScreen(
    postJump.map((p) => ({ providerId: p.providerId, price: p.price! })),
    config.screening,
  );
  exclusions.push(...screen.exclusions);
  const keptResults = postJump.filter((p) =>
    screen.kept.some((k) => k.providerId === p.providerId),
  );

  // 4–5. Weights by executable flag, then the iterative cap.
  const capped = capWeights(
    keptResults.map((p) => ({
      providerId: p.providerId,
      weight: p.executable ? config.weights.executable : config.weights.rateCard,
    })),
    config.weightCap,
  );

  // 6. Weighted mean.
  const totalWeight = capped.reduce((a, c) => a + c.weightAfterCap, 0);
  const contributors: ContributionReceipt[] = capped.map((c) => {
    const p = keptResults.find((k) => k.providerId === c.providerId)!;
    const stat = input.providerStats.get(c.providerId);
    return {
      providerId: c.providerId,
      price: p.price!,
      weightBeforeCap: c.weightBeforeCap,
      weightAfterCap: c.weightAfterCap,
      executable: p.executable,
      sampleSize: p.sampleSize,
      method: p.method,
      sigma: stat?.sigma ?? null,
    };
  });

  const hasContributors = contributors.length > 0 && totalWeight > 0;
  const weightedPrice = hasContributors
    ? contributors.reduce((a, c) => a + c.price * c.weightAfterCap, 0) / totalWeight
    : null;
  const price = weightedPrice === null ? null : round4(weightedPrice);

  // 7. Dispersion of the kept providers (robust, scale-free).
  const dispersion = screen.kept.length > 0 ? screen.dispersion : 0;

  // 8. Confidence band from p±σ votes.
  const band: ConfidenceBand | null = hasContributors
    ? confidenceBand(
        contributors.map((c) => ({
          providerId: c.providerId,
          price: c.price,
          sigma: Math.max(config.confidence.voteSigmaFloor, c.sigma ?? 0),
          weight: c.weightAfterCap,
        })),
      )
    : null;

  // 9. Gates and status.
  const gates = evaluateGates({
    contributors,
    now: input.now,
    lastPriceAt: new Map(
      [...input.providerStats.entries()].map(([id, s]) => [id, s.lastPriceAt ?? null]),
    ),
    gates: config.gates,
    dispersion,
    dispersionConfig: config.dispersion,
  });

  let status: IndexStatus;
  let finalPrice: number | null;
  let priorCandidateId: string | null = null;
  if (!hasContributors) {
    const prior = input.prior;
    if (
      prior !== null &&
      input.now.getTime() - prior.computedAt.getTime() <= config.stale.carryForwardWindowMs
    ) {
      status = "stale";
      finalPrice = round4(prior.price);
      priorCandidateId = prior.candidateId;
    } else {
      status = "withheld";
      finalPrice = null;
    }
  } else {
    finalPrice = price;
    const gatesPassed = gates.every((g) => g.passed);
    if (!gatesPassed) {
      status = "withheld";
    } else if (dispersion > config.dispersion.warn) {
      status = "degraded";
    } else if (contributors.length < input.config.gates.minProviders) {
      // A panel computing on a relaxed quorum (panelOverrides) may pass its
      // own gates, but it has not met the full settlement quorum — it can
      // never claim `healthy`. This is the honesty ceiling for thin SKUs.
      status = "degraded";
    } else {
      status = "healthy";
    }
  }

  const calcParams: Record<string, unknown> = {
    config,
    priorCandidateId,
    priceSource: hasContributors ? "computed" : priorCandidateId !== null ? "prior" : "none",
  };

  const computedAt = input.now;
  const core = {
    gpuId: input.gpu.id,
    panelId: input.panelId,
    price: finalPrice,
    confidenceLow: status === "withheld" ? null : band?.low ?? null,
    confidenceHigh: status === "withheld" ? null : band?.high ?? null,
    dispersion,
    status,
    gates,
    contributors,
    exclusions,
    providersObserved,
    providersContributing: contributors.length,
    methodologyVersion: config.version,
    calcParams,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    computedAt,
  };
  const receipt = canonicalJson(core);
  return { ...core, receipt };
}
