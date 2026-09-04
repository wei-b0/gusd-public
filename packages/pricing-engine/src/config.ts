import type { PricingTier } from "@gusd/types";

/**
 * Methodology v0.1.0 configuration. Thresholds live in config, never in
 * code: a methodology change is a new config + new version, validated by the
 * exhaustive allowlist below before it can drive a computation.
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
}

export const DEFAULT_METHODOLOGY_CONFIG: MethodologyConfig = {
  version: "0.1.0",
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

  return input as unknown as MethodologyConfig;
}
