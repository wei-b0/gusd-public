import { effectiveConfigFor, type MethodologyConfig } from "@gusd/pricing-engine";
import type { PublisherConfig, ResolvedPublisherConfig } from "./types.js";

/**
 * Per-panel publication thresholds: the methodology's own numbers for this
 * panel (its `panelOverrides` merged over the global config — the same pure
 * merge the oracle runs), with any operator-configured absolute limits applied
 * tighten-only. The values deliberately come from the stored methodology row,
 * never from the candidate's self-reported receipt — a compromised oracle
 * cannot relax its own publication gate.
 */
export function resolvePanelThresholds(
  config: PublisherConfig,
  methodology: MethodologyConfig,
  panelId: string,
): ResolvedPublisherConfig {
  const effective = effectiveConfigFor(methodology, panelId);
  return {
    ...config,
    minContributors: Math.max(config.minContributors ?? 0, effective.gates.minProviders),
    maxDispersion: Math.min(
      config.maxDispersion ?? Number.POSITIVE_INFINITY,
      effective.dispersion.max,
    ),
    maxBandWidthPct: Math.min(
      config.maxBandWidthPct ?? Number.POSITIVE_INFINITY,
      effective.dispersion.max,
    ),
  };
}
