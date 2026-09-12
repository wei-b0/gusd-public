import type { PricingTier } from "@gusd/types";
import { SETTLEMENT_PANELS } from "@gusd/gpu-catalog";

/**
 * Methodology v0.4.0 configuration. Thresholds live in config, never in
 * code: a methodology change is a new config + new version, validated by the
 * exhaustive allowlist below before it can drive a computation. v0.4.0 keeps
 * per-panel overrides so thin panels can settle — promoted COLLECTED
 * principals on a reduced quorum, with the engine capping override panels at
 * `degraded`.
 */

export interface ScreeningConfig {
  /** The cross-provider MAD screen only arms at this many providers. */
  minProvidersForScreen: number;
  /** MAD × this ≈ one Gaussian σ. */
  madScale: number;
  /** Providers beyond this many σ (madScale·MAD) from the median are excluded. */
  sigmaLimit: number;
  /**
   * When MAD = 0 (a tie consensus — exactly the shape a flooding attacker
   * wants) the σ screen is useless; fall back to a symmetric ratio band:
   * keep only prices within [median/ratio, median·ratio].
   */
  madZeroRatioBand: number;
}

export interface AggregationConfig {
  /** Order-book depth floors: below this the book is too thin to price. */
  minMachinesForBook: number;
  minHostsForBook: number;
  /** |round(perGpu,4)·n − total| ≤ tolerance·n, else the row is a lie. */
  arithmeticTolerancePerGpu: number;
  /** num_gpus ∈ [min,max] — never defaulted, out-of-range rows are excluded. */
  gpuCountMin: number;
  gpuCountMax: number;
  /** Tiers eligible for settlement aggregation. */
  eligibleTiers: readonly PricingTier[];
}

export interface WeightsConfig {
  executable: number;
  rateCard: number;
}

export interface DispersionConfig {
  /** Above this the index is withheld. */
  max: number;
  /** Above this the index is published as `degraded`. */
  warn: number;
}

export interface ConfidenceConfig {
  /** Per-provider vote σ floor, as a fraction of the provider price. */
  voteSigmaFloor: number;
}

export interface GatesConfig {
  minProviders: number;
  minObservations: number;
  maxObservationAgeMs: number;
  requireExecutable: boolean;
}

export interface StaleConfig {
  /** A fresh-enough prior may be carried forward (flagged `stale`), never older. */
  carryForwardWindowMs: number;
}

export interface JumpConfig {
  /** A provider moving ≥ this fraction vs its own trailing median is suspect. */
  maxProviderJumpPct: number;
  /** ...unless at least this many other providers moved ≥ minCorroboratorMovePct. */
  minCorroborators: number;
  minCorroboratorMovePct: number;
}

/**
 * The publishing movement allowance (methodology v0.3.0). Rate-card-settled
 * panels (L40S today) have no dynamic source — their computed anchor
 * is genuinely static for days, which reads as a dead tape. The allowance
 * lets the *published* figure carry a bounded, deterministic, mean-reverting
 * offset around the computed anchor so every panel prints a moving series.
 * It is confessed in the methodology and recorded per receipt
 * (calcParams.movementOffset); the anchor itself is untouched, so screens,
 * weights, dispersion, band and gates all compute on real data. Absent
 * section ⇒ disabled (a stored pre-0.3.0 config validates unchanged).
 */
export interface MovementConfig {
  /** Max |published − anchor| as a fraction of the anchor. 0 disables. */
  allowancePct: number;
  /** The randomness reseeds at most once per this many ms (0 = every publication). */
  slotMs: number;
  /** Fraction of the current published-vs-anchor gap carried forward. */
  reversion: number;
  /** Per-slot step as a fraction of the full allowance. */
  stepPct: number;
}

export interface MethodologyConfig {
  version: string;
  screening: ScreeningConfig;
  aggregation: AggregationConfig;
  weights: WeightsConfig;
  /** No single provider may exceed this fraction of total weight (post-cap). */
  weightCap: number;
  dispersion: DispersionConfig;
  confidence: ConfidenceConfig;
  gates: GatesConfig;
  stale: StaleConfig;
  jump: JumpConfig;
  /** Optional publishing movement allowance — absent on pre-0.3.0 configs. */
  movement?: MovementConfig;
  /**
   * Per-panel relaxations for SKUs whose settlement-eligible set cannot reach
   * the global quorum. An override may only ever *relax* the gates — the
   * engine enforces that a panel computing below the global min_providers
   * publishes `degraded` at best, never `healthy`.
   */
  panelOverrides: Record<string, PanelOverride>;
}

export interface PanelOverride {
  /**
   * Providers promoted to settlement-eligible for this panel only — rate-card
   * principals backing SKUs the executable order books do not carry. The
   * global registry role is unchanged; the promotion lives in the versioned
   * methodology so every receipt records exactly who was allowed to vote.
   */
  additionalProviders?: readonly string[];
  /** Sparse patch over the global gates for this panel. */
  gates?: Partial<GatesConfig>;
  /** Sparse patch over the global dispersion thresholds for this panel. */
  dispersion?: Partial<DispersionConfig>;
}

export const DEFAULT_METHODOLOGY_CONFIG: MethodologyConfig = {
  version: "0.4.0",
  screening: {
    minProvidersForScreen: 4,
    madScale: 1.4826,
    sigmaLimit: 3,
    madZeroRatioBand: 3,
  },
  aggregation: {
    minMachinesForBook: 5,
    minHostsForBook: 3,
    arithmeticTolerancePerGpu: 0.005,
    gpuCountMin: 1,
    gpuCountMax: 16,
    eligibleTiers: ["on_demand"],
  },
  weights: { executable: 1.0, rateCard: 0.6 },
  weightCap: 0.35,
  dispersion: { max: 0.45, warn: 0.25 },
  confidence: { voteSigmaFloor: 0.03 },
  gates: {
    minProviders: 4,
    minObservations: 3,
    maxObservationAgeMs: 1_800_000, // 30 minutes
    requireExecutable: true,
  },
  stale: { carryForwardWindowMs: 86_400_000 }, // 24 hours
  jump: { maxProviderJumpPct: 0.25, minCorroborators: 2, minCorroboratorMovePct: 0.10 },
  // The publishing movement allowance: the published figure wobbles within
  // ±0.05% of the computed anchor (mean-reverting, deterministic). Confessed
  // on the methodology page; the anchor is never moved by it.
  movement: { allowancePct: 0.0005, slotMs: 30_000, reversion: 0.7, stepPct: 0.4 },
  // The v0.4.0 launch universe (H100/H200/L40S/RTX 4090). H100/H200 keep the
  // full global quorum; the two thin panels run on reduced quorums over named
  // principals and are capped at `degraded` by the engine.
  panelOverrides: {
    L40S_PANEL_V1: {
      // Vast's verified+rentable L40S book is too thin to settle alone and
      // RunPod lists without stock; DataCrunch/Scaleway/CoreWeave carry live
      // L40S rate cards, so the panel settles over them (rate-card weights).
      // Temporary: revert to the global gates once executable L40S order
      // books deepen.
      additionalProviders: ["datacrunch", "scaleway", "coreweave"],
      gates: { minProviders: 3, requireExecutable: false },
    },
    RTX_4090_PANEL_V1: {
      // Vast + RunPod are executable; Akash's rtx4090 rate card completes the
      // quorum without giving up the executable floor.
      additionalProviders: ["akash"],
      gates: { minProviders: 3, requireExecutable: true },
    },
  },
};

const PRICING_TIERS: readonly PricingTier[] = [
  "on_demand",
  "community",
  "spot",
  "preemptible",
  "reserved",
  "committed",
];

// --- exhaustive allowlist validation -----------------------------------------

function fail(path: string, why: string): never {
  throw new Error(`invalid methodology config at ${path}: ${why}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertKeys(obj: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const k of keys) {
    if (!(k in obj)) fail(`${path}.${k}`, "missing");
  }
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k)) fail(`${path}.${k}`, "unknown key");
  }
}

function num(obj: Record<string, unknown>, key: string, path: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${path}.${key}`, "must be a finite number");
  return v;
}

function int(obj: Record<string, unknown>, key: string, path: string): number {
  const v = num(obj, key, path);
  if (!Number.isInteger(v)) fail(`${path}.${key}`, "must be an integer");
  return v;
}

function bool(obj: Record<string, unknown>, key: string, path: string): boolean {
  const v = obj[key];
  if (typeof v !== "boolean") fail(`${path}.${key}`, "must be a boolean");
  return v;
}

/**
 * Validates a MethodologyConfig from untrusted input (DB jsonb, operator
 * file). Unknown keys, missing keys and out-of-range values all throw — a
 * config that half-matches must fail loudly, never partially apply.
 */
export function validateMethodologyConfig(input: unknown): MethodologyConfig {
  if (!isPlainObject(input)) fail("", "config must be an object");
  assertKeys(
    input,
    [
      "version",
      "screening",
      "aggregation",
      "weights",
      "weightCap",
      "dispersion",
      "confidence",
      "gates",
      "stale",
      "jump",
      "panelOverrides",
      // Optional v0.3.0 section — only listed when present, so a stored
      // pre-0.3.0 config validates unchanged.
      ...(input.movement !== undefined ? ["movement" as const] : []),
    ],
    "",
  );

  const version = input.version;
  if (typeof version !== "string" || version.length === 0 || version.length > 64) {
    fail("version", "must be a non-empty string of at most 64 chars");
  }

  const screening = input.screening;
  if (!isPlainObject(screening)) fail("screening", "must be an object");
  assertKeys(
    screening,
    ["minProvidersForScreen", "madScale", "sigmaLimit", "madZeroRatioBand"],
    "screening",
  );
  if (int(screening, "minProvidersForScreen", "screening") < 1) {
    fail("screening.minProvidersForScreen", "must be ≥ 1");
  }
  if (num(screening, "madScale", "screening") <= 0) fail("screening.madScale", "must be > 0");
  if (num(screening, "sigmaLimit", "screening") <= 0) fail("screening.sigmaLimit", "must be > 0");
  if (num(screening, "madZeroRatioBand", "screening") <= 1) {
    fail("screening.madZeroRatioBand", "must be > 1 (a symmetric ratio band)");
  }

  const aggregation = input.aggregation;
  if (!isPlainObject(aggregation)) fail("aggregation", "must be an object");
  assertKeys(
    aggregation,
    [
      "minMachinesForBook",
      "minHostsForBook",
      "arithmeticTolerancePerGpu",
      "gpuCountMin",
      "gpuCountMax",
      "eligibleTiers",
    ],
    "aggregation",
  );
  if (int(aggregation, "minMachinesForBook", "aggregation") < 1) {
    fail("aggregation.minMachinesForBook", "must be ≥ 1");
  }
  if (int(aggregation, "minHostsForBook", "aggregation") < 1) {
    fail("aggregation.minHostsForBook", "must be ≥ 1");
  }
  if (num(aggregation, "arithmeticTolerancePerGpu", "aggregation") < 0) {
    fail("aggregation.arithmeticTolerancePerGpu", "must be ≥ 0");
  }
  const gpuCountMin = int(aggregation, "gpuCountMin", "aggregation");
  const gpuCountMax = int(aggregation, "gpuCountMax", "aggregation");
  if (gpuCountMin < 1) fail("aggregation.gpuCountMin", "must be ≥ 1");
  if (gpuCountMax < gpuCountMin) fail("aggregation.gpuCountMax", "must be ≥ gpuCountMin");
  const tiers = aggregation.eligibleTiers;
  if (!Array.isArray(tiers) || tiers.length === 0) {
    fail("aggregation.eligibleTiers", "must be a non-empty array");
  }
  for (const t of tiers) {
    if (!PRICING_TIERS.includes(t as PricingTier)) {
      fail("aggregation.eligibleTiers", `unknown pricing tier ${String(t)}`);
    }
  }

  const weights = input.weights;
  if (!isPlainObject(weights)) fail("weights", "must be an object");
  assertKeys(weights, ["executable", "rateCard"], "weights");
  const wExec = num(weights, "executable", "weights");
  const wRate = num(weights, "rateCard", "weights");
  if (wExec <= 0 || wRate <= 0) fail("weights", "both weights must be > 0");
  if (wExec < wRate) fail("weights", "executable weight must be ≥ rateCard weight");

  const weightCap = num(input, "weightCap", "");
  if (weightCap <= 0 || weightCap >= 1) fail("weightCap", "must be in (0, 1)");

  const dispersion = input.dispersion;
  if (!isPlainObject(dispersion)) fail("dispersion", "must be an object");
  assertKeys(dispersion, ["max", "warn"], "dispersion");
  const dMax = num(dispersion, "max", "dispersion");
  const dWarn = num(dispersion, "warn", "dispersion");
  if (dMax <= 0) fail("dispersion.max", "must be > 0");
  if (dWarn <= 0 || dWarn >= dMax) fail("dispersion.warn", "must be in (0, max)");

  const confidence = input.confidence;
  if (!isPlainObject(confidence)) fail("confidence", "must be an object");
  assertKeys(confidence, ["voteSigmaFloor"], "confidence");
  const floor = num(confidence, "voteSigmaFloor", "confidence");
  if (floor <= 0 || floor >= 1) fail("confidence.voteSigmaFloor", "must be in (0, 1)");

  const gates = input.gates;
  if (!isPlainObject(gates)) fail("gates", "must be an object");
  assertKeys(
    gates,
    ["minProviders", "minObservations", "maxObservationAgeMs", "requireExecutable"],
    "gates",
  );
  if (int(gates, "minProviders", "gates") < 1) fail("gates.minProviders", "must be ≥ 1");
  if (int(gates, "minObservations", "gates") < 1) fail("gates.minObservations", "must be ≥ 1");
  if (num(gates, "maxObservationAgeMs", "gates") <= 0) {
    fail("gates.maxObservationAgeMs", "must be > 0");
  }
  bool(gates, "requireExecutable", "gates");

  const stale = input.stale;
  if (!isPlainObject(stale)) fail("stale", "must be an object");
  assertKeys(stale, ["carryForwardWindowMs"], "stale");
  if (num(stale, "carryForwardWindowMs", "stale") <= 0) {
    fail("stale.carryForwardWindowMs", "must be > 0");
  }

  const jump = input.jump;
  if (!isPlainObject(jump)) fail("jump", "must be an object");
  assertKeys(
    jump,
    ["maxProviderJumpPct", "minCorroborators", "minCorroboratorMovePct"],
    "jump",
  );
  const jumpPct = num(jump, "maxProviderJumpPct", "jump");
  if (jumpPct <= 0) fail("jump.maxProviderJumpPct", "must be > 0");
  if (int(jump, "minCorroborators", "jump") < 1) fail("jump.minCorroborators", "must be ≥ 1");
  const move = num(jump, "minCorroboratorMovePct", "jump");
  if (move <= 0 || move > jumpPct) {
    fail("jump.minCorroboratorMovePct", "must be in (0, maxProviderJumpPct]");
  }

  const movement = input.movement;
  if (movement !== undefined) {
    if (!isPlainObject(movement)) fail("movement", "must be an object");
    assertKeys(movement, ["allowancePct", "slotMs", "reversion", "stepPct"], "movement");
    const allowance = num(movement, "allowancePct", "movement");
    if (allowance < 0 || allowance > 0.1) fail("movement.allowancePct", "must be in [0, 0.1]");
    if (int(movement, "slotMs", "movement") < 0) fail("movement.slotMs", "must be ≥ 0");
    const reversion = num(movement, "reversion", "movement");
    if (reversion < 0 || reversion >= 1) fail("movement.reversion", "must be in [0, 1)");
    const step = num(movement, "stepPct", "movement");
    if (step <= 0 || step > 1) fail("movement.stepPct", "must be in (0, 1]");
  }

  const overrides = input.panelOverrides;
  if (!isPlainObject(overrides)) fail("panelOverrides", "must be an object");
  const panelIds = new Set(SETTLEMENT_PANELS.map((p) => p.id));
  for (const [panelId, raw] of Object.entries(overrides)) {
    if (!panelIds.has(panelId)) {
      fail(`panelOverrides.${panelId}`, "not a known settlement panel id");
    }
    if (!isPlainObject(raw)) fail(`panelOverrides.${panelId}`, "must be an object");
    const keys = Object.keys(raw);
    if (keys.length === 0) {
      fail(`panelOverrides.${panelId}`, "empty override — drop it or name a relaxation");
    }
    for (const k of keys) {
      if (!["additionalProviders", "gates", "dispersion"].includes(k)) {
        fail(`panelOverrides.${panelId}.${k}`, "unknown key");
      }
    }
    const override = raw as PanelOverride;
    if (override.additionalProviders !== undefined) {
      const slugs = override.additionalProviders;
      if (!Array.isArray(slugs) || slugs.length === 0) {
        fail(`panelOverrides.${panelId}.additionalProviders`, "must be a non-empty array");
      }
      for (const slug of slugs) {
        if (typeof slug !== "string" || slug.length === 0 || slug.length > 64) {
          fail(`panelOverrides.${panelId}.additionalProviders`, "slugs must be 1-64 char strings");
        }
      }
      if (new Set(slugs).size !== slugs.length) {
        fail(`panelOverrides.${panelId}.additionalProviders`, "duplicate provider slug");
      }
    }
    if (override.gates !== undefined) {
      if (!isPlainObject(override.gates) || Object.keys(override.gates).length === 0) {
        fail(`panelOverrides.${panelId}.gates`, "must be a non-empty partial gates object");
      }
      for (const k of Object.keys(override.gates)) {
        if (!["minProviders", "minObservations", "maxObservationAgeMs", "requireExecutable"].includes(k)) {
          fail(`panelOverrides.${panelId}.gates.${k}`, "unknown gate");
        }
      }
      if (override.gates.minProviders !== undefined) {
        if (!Number.isInteger(override.gates.minProviders) || override.gates.minProviders < 1) {
          fail(`panelOverrides.${panelId}.gates.minProviders`, "must be an integer ≥ 1");
        }
      }
      if (override.gates.minObservations !== undefined) {
        if (!Number.isInteger(override.gates.minObservations) || override.gates.minObservations < 1) {
          fail(`panelOverrides.${panelId}.gates.minObservations`, "must be an integer ≥ 1");
        }
      }
      if (override.gates.maxObservationAgeMs !== undefined) {
        if (typeof override.gates.maxObservationAgeMs !== "number" || override.gates.maxObservationAgeMs <= 0) {
          fail(`panelOverrides.${panelId}.gates.maxObservationAgeMs`, "must be > 0");
        }
      }
      if (override.gates.requireExecutable !== undefined && typeof override.gates.requireExecutable !== "boolean") {
        fail(`panelOverrides.${panelId}.gates.requireExecutable`, "must be a boolean");
      }
    }
    if (override.dispersion !== undefined) {
      if (!isPlainObject(override.dispersion) || Object.keys(override.dispersion).length === 0) {
        fail(`panelOverrides.${panelId}.dispersion`, "must be a non-empty partial dispersion object");
      }
      for (const k of Object.keys(override.dispersion)) {
        if (!["max", "warn"].includes(k)) fail(`panelOverrides.${panelId}.dispersion.${k}`, "unknown key");
      }
      const oMax = override.dispersion.max ?? dMax;
      const oWarn = override.dispersion.warn ?? dWarn;
      if (typeof oMax !== "number" || oMax <= 0) {
        fail(`panelOverrides.${panelId}.dispersion.max`, "must be > 0");
      }
      if (typeof oWarn !== "number" || oWarn <= 0 || oWarn >= oMax) {
        fail(`panelOverrides.${panelId}.dispersion`, "warn must remain in (0, max) after the patch");
      }
    }
  }

  return input as unknown as MethodologyConfig;
}

/**
 * The config a given panel actually computes under: the global methodology
 * with its override patch applied. Deriving this deterministically (rather
 * than mutating the stored config) keeps receipts replayable — the same
 * stored row always yields the same effective config for a panel.
 */
export function effectiveConfigFor(
  config: MethodologyConfig,
  panelId: string,
): MethodologyConfig {
  const override = config.panelOverrides[panelId];
  if (!override || (override.gates === undefined && override.dispersion === undefined)) {
    return config;
  }
  return {
    ...config,
    gates: override.gates ? { ...config.gates, ...override.gates } : config.gates,
    dispersion: override.dispersion
      ? { ...config.dispersion, ...override.dispersion }
      : config.dispersion,
  };
}
