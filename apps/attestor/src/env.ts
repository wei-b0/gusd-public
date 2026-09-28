import { DEFAULT_METHODOLOGY_CONFIG } from "@gusd/pricing-engine";
import type { AttestorConfig } from "./types.js";
import { EPOCH_LENGTH_DEFAULT, MAX_OBSERVATION_AGE_DEFAULT } from "@gusd/attestor-client";

/**
 * The attestor's settings. No chain-target variables exist any more: the
 * attestor never broadcasts — its only output is a signature and a DB row.
 * The chain identity below (ATTESTOR_CHAIN_ID + ATTESTOR_ORACLE_ADDRESS) is
 * the EIP-712 domain the signature binds to, not an RPC.
 */
export interface AttestorEnv extends AttestorConfig {
  databaseUrl: string;
  /** The oracle API — candidate reading is via the DB; this only serves /v1/health (breaker state). */
  oracleUrl: string;
  pollMs: number;
  logLevel: string;
  /** Attestor key — signing only, never broadcast; never an owner/deployer key on live chains. */
  privateKey: `0x${string}`;
  /** Expected chain id — the EIP-712 domain is bound to it; cross-chain replay is rejected. */
  chainId: number;
  /** The deployed GpuOracle address — the EIP-712 domain's verifyingContract. */
  oracleAddress: `0x${string}`;
  /** Deterministic epoch length (seconds) — must match the GpuOracle constructor value. */
  epochLength: number;
  /** Observation floor (seconds) — must match the GpuOracle constructor value and be >= epochLength. */
  maxObservationAge: number;
}

function intEnv(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

function numEnv(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) {
    throw new Error(`${name} must be a fraction in (0,1), got "${raw}"`);
  }
  return n;
}

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function parseAttestorEnv(env: NodeJS.ProcessEnv = process.env): AttestorEnv {
  const privateKey = env.ATTESTOR_PRIVATE_KEY;
  if (!privateKey || !PRIVATE_KEY_RE.test(privateKey)) {
    throw new Error("ATTESTOR_PRIVATE_KEY must be a 32-byte hex private key");
  }
  const oracleAddress = env.ATTESTOR_ORACLE_ADDRESS;
  if (!oracleAddress || !ADDRESS_RE.test(oracleAddress)) {
    throw new Error("ATTESTOR_ORACLE_ADDRESS must be a 20-byte hex address (the GpuOracle)");
  }
  const chainId = intEnv("ATTESTOR_CHAIN_ID", env.ATTESTOR_CHAIN_ID, 0);
  if (chainId <= 0) {
    throw new Error("ATTESTOR_CHAIN_ID must be a positive integer");
  }
  const epochLength = intEnv("ATTESTOR_EPOCH_LENGTH", env.ATTESTOR_EPOCH_LENGTH, EPOCH_LENGTH_DEFAULT);
  const maxObservationAge = intEnv(
    "ATTESTOR_MAX_OBSERVATION_AGE",
    env.ATTESTOR_MAX_OBSERVATION_AGE,
    MAX_OBSERVATION_AGE_DEFAULT,
  );
  if (maxObservationAge < epochLength) {
    throw new Error(
      `ATTESTOR_MAX_OBSERVATION_AGE (${maxObservationAge}) must be >= ATTESTOR_EPOCH_LENGTH (${epochLength})`,
    );
  }
  return {
    databaseUrl:
      env.DATABASE_URL ?? "postgres://gusd:gusd@localhost:54329/gusd",
    oracleUrl: env.ATTESTOR_ORACLE_URL ?? "http://127.0.0.1:8080",
    pollMs: intEnv("ATTESTOR_POLL_MS", env.ATTESTOR_POLL_MS, 5_000),
    // Default: the methodology the shipped pricing engine computes with — one
    // source of truth, so the pin cannot drift from what the oracle stamps on
    // candidates (a stale hand-copied string fails closed: every candidate
    // rejects on methodology_mismatch, forever). Override with
    // ATTESTOR_METHODOLOGY_VERSION to pin a different stored row.
    pinnedMethodologyVersion:
      env.ATTESTOR_METHODOLOGY_VERSION ?? DEFAULT_METHODOLOGY_CONFIG.version,
    // Contributor/dispersion/band limits default to the pinned methodology's
    // per-panel values (panelOverrides included); an explicit env var is a
    // tighten-only override, never a relaxation of the methodology.
    minContributors:
      env.ATTESTOR_MIN_CONTRIBUTORS === undefined || env.ATTESTOR_MIN_CONTRIBUTORS === ""
        ? null
        : intEnv("ATTESTOR_MIN_CONTRIBUTORS", env.ATTESTOR_MIN_CONTRIBUTORS, 1),
    maxDispersion:
      env.ATTESTOR_MAX_DISPERSION === undefined || env.ATTESTOR_MAX_DISPERSION === ""
        ? null
        : numEnv("ATTESTOR_MAX_DISPERSION", env.ATTESTOR_MAX_DISPERSION, 0),
    // Matches the contract's MAX_OBSERVATION_AGE default (300s): a candidate
    // older than the floor cannot be attested at all (the poller hard-stops),
    // so the audit's freshness annotation and the floor coincide by default.
    maxFreshnessMs: intEnv("ATTESTOR_MAX_FRESHNESS_MS", env.ATTESTOR_MAX_FRESHNESS_MS, 300_000),
    maxJumpPct: numEnv("ATTESTOR_MAX_JUMP_PCT", env.ATTESTOR_MAX_JUMP_PCT, 0.25),
    maxBandWidthPct:
      env.ATTESTOR_MAX_BAND_WIDTH_PCT === undefined || env.ATTESTOR_MAX_BAND_WIDTH_PCT === ""
        ? null
        : numEnv("ATTESTOR_MAX_BAND_WIDTH_PCT", env.ATTESTOR_MAX_BAND_WIDTH_PCT, 0),
    privateKey: privateKey as `0x${string}`,
    oracleAddress: oracleAddress as `0x${string}`,
    chainId,
    epochLength,
    maxObservationAge,
    logLevel: env.LOG_LEVEL ?? "info",
  };
}
