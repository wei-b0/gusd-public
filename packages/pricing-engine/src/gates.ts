import type { ContributionReceipt, Gate } from "@gusd/types";
import type { GatesConfig } from "./config.js";
import type { DispersionConfig } from "./config.js";

/**
 * Publication gates. A failed gate means `withheld`: the computation is
 * stored with its full receipt, but it is never publishable. Gates are the
 * last line of defense — everything upstream is screens.
 */
export interface GateInput {
  contributors: readonly ContributionReceipt[];
  now: Date;
  /** Most recent observation time per contributing provider. */
  lastPriceAt: ReadonlyMap<string, Date | null>;
  gates: GatesConfig;
  dispersion: number;
  dispersionConfig: DispersionConfig;
}

export function evaluateGates(input: GateInput): Gate[] {
  const { gates } = input;
  const out: Gate[] = [];

  const providerCount = input.contributors.length;
  out.push({
    name: "min_providers",
    passed: providerCount >= gates.minProviders,
    observed: providerCount,
    threshold: gates.minProviders,
  });

  const observationCount = input.contributors.reduce((a, c) => a + c.sampleSize, 0);
  out.push({
    name: "min_observations",
    passed: observationCount >= gates.minObservations,
    observed: observationCount,
    threshold: gates.minObservations,
  });

  // Freshness: the oldest contributing provider's most recent print must be
  // within the window. A provider with unknown freshness fails the gate.
  let oldestAt: Date | null = null;
  let unknownFreshness = false;
  for (const c of input.contributors) {
    const at = input.lastPriceAt.get(c.providerId);
    if (at === undefined || at === null) {
      unknownFreshness = true;
      continue;
    }
    if (oldestAt === null || at < oldestAt) oldestAt = at;
  }
  if (unknownFreshness || oldestAt === null) {
    out.push({
      name: "freshness",
      passed: false,
      observed: null,
      threshold: gates.maxObservationAgeMs,
      reason: "contributing provider has no known last-observation time",
    });
  } else {
    const oldestAgeMs = input.now.getTime() - oldestAt.getTime();
    out.push({
      name: "freshness",
      passed: oldestAgeMs <= gates.maxObservationAgeMs,
      observed: oldestAgeMs,
      threshold: gates.maxObservationAgeMs,
    });
  }

  if (gates.requireExecutable) {
    const executableCount = input.contributors.filter((c) => c.executable).length;
    const gate: Gate = {
      name: "require_executable",
      passed: executableCount >= 1,
      observed: executableCount,
      threshold: 1,
    };
    if (executableCount === 0) gate.reason = "no executable contribution";
    out.push(gate);
  }

  out.push({
    name: "max_dispersion",
    passed: input.dispersion <= input.dispersionConfig.max,
    observed: input.dispersion,
    threshold: input.dispersionConfig.max,
  });

  return out;
}
