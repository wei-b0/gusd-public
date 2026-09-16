import { DEFAULT_METHODOLOGY_CONFIG } from "@gusd/pricing-engine";
import type { PublisherConfig } from "./types.js";

/** Where publishes land. `chain` signs and submits to GPUPriceOracle. */
export type PublisherTargetKind = "mock" | "chain";

export interface PublisherEnv extends PublisherConfig {
  databaseUrl: string;
  oracleUrl: string;
  pollMs: number;
  target: PublisherTargetKind;
  logLevel: string;
  /** Required when target=chain; null otherwise. */
  rpcUrl: string | null;
  /** Publisher EOA key — publish-role only, never owner/deployer on live chains. */
  privateKey: string | null;
  /** Deployed GPUPriceOracle address. */
  oracleAddress: string | null;
  /** Expected chain id — verify() aborts boot on mismatch. */
  chainId: number | null;
  /** Receipt wait limit. */
  txTimeoutMs: number;
  /** Publication tx fee ceiling in wei (PUBLISHER_MAX_FEE_GWEI) — the
   *  slow/cheap inclusion tier, with a zero priority fee. When the chain's
   *  base fee is above the ceiling the tx queues/fails to submit and the
   *  poller retries on a later tick; success is still only ever a mined
   *  receipt. */
  maxFeePerGasWei: bigint;
}

function intEnv(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

/**
 * Decimal gwei → wei, exactly. Gwei stops at 9 decimal places (wei
 * granularity), so the value parses digit-wise rather than through a float —
 * 0.05 gwei must come out as exactly 50_000_000 wei. Signs and exponent
 * notation are rejected; zero is meaningless as a fee ceiling.
 */
function gweiEnv(name: string, raw: string | undefined, fallback: string): bigint {
  const value = (raw === undefined || raw === "" ? fallback : raw).trim();
  if (!/^\d+(\.\d{1,9})?$/.test(value) || Number(value) === 0) {
    throw new Error(
      `${name} must be a decimal gwei value > 0 with at most 9 fractional digits, got "${value}"`,
    );
  }
  const parts = value.split(".");
  const whole = parts[0] ?? "0"; // regex guarantees digits before any "."
  const frac = (parts[1] ?? "").padEnd(9, "0"); // gwei has at most 9 decimals
  return BigInt(whole) * 1_000_000_000n + BigInt(frac);
}

function numEnv(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) {
    throw new Error(`${name} must be a fraction in (0,1), got "${raw}"`);
  }
  return n;
}

/** Fail-closed target gate: an unset or unknown PUBLISHER_TARGET is the mock. */
function targetEnv(raw: string | undefined): PublisherTargetKind {
  const value = raw ?? "mock";
  if (value !== "mock" && value !== "chain") {
    throw new Error(`PUBLISHER_TARGET must be "mock" or "chain", got "${value}"`);
  }
  return value;
}

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Chain-target settings, validated here — no web3 library at parse time. */
function chainEnv(target: PublisherTargetKind, env: NodeJS.ProcessEnv) {
  if (target === "mock") {
    return { rpcUrl: null, privateKey: null, oracleAddress: null, chainId: null, txTimeoutMs: 120_000 };
  }
  const rpcUrl = env.PUBLISHER_RPC_URL;
  if (!rpcUrl) throw new Error("PUBLISHER_RPC_URL is required when PUBLISHER_TARGET=chain");
  const privateKey = env.PUBLISHER_PRIVATE_KEY;
  if (!privateKey || !PRIVATE_KEY_RE.test(privateKey)) {
    throw new Error("PUBLISHER_PRIVATE_KEY must be a 32-byte hex private key when PUBLISHER_TARGET=chain");
  }
  const oracleAddress = env.PUBLISHER_ORACLE_ADDRESS;
  if (!oracleAddress || !ADDRESS_RE.test(oracleAddress)) {
    throw new Error("PUBLISHER_ORACLE_ADDRESS must be a 20-byte hex address when PUBLISHER_TARGET=chain");
  }
  const chainId = env.PUBLISHER_CHAIN_ID
    ? intEnv("PUBLISHER_CHAIN_ID", env.PUBLISHER_CHAIN_ID, 0)
    : 0; // flagged below — intEnv's fallback path must not mask a missing id
  if (chainId <= 0) {
    throw new Error("PUBLISHER_CHAIN_ID must be a positive integer when PUBLISHER_TARGET=chain");
  }
  const txTimeoutMs = intEnv("PUBLISHER_TX_TIMEOUT_MS", env.PUBLISHER_TX_TIMEOUT_MS, 120_000);
  return { rpcUrl, privateKey, oracleAddress, chainId, txTimeoutMs };
}

export function parsePublisherEnv(env: NodeJS.ProcessEnv = process.env): PublisherEnv {
  const target = targetEnv(env.PUBLISHER_TARGET);
  return {
    databaseUrl:
      env.DATABASE_URL ?? "postgres://gusd:gusd@localhost:54329/gusd",
    oracleUrl: env.PUBLISHER_ORACLE_URL ?? "http://127.0.0.1:8080",
    pollMs: intEnv("PUBLISHER_POLL_MS", env.PUBLISHER_POLL_MS, 5_000),
    // Default: the methodology the shipped pricing engine computes with — one
    // source of truth, so the pin cannot drift from what the oracle stamps on
    // candidates (a stale hand-copied string fails closed: every candidate
    // rejects on methodology_mismatch, forever). Override with
    // PUBLISHER_METHODOLOGY_VERSION to pin a different stored row.
    pinnedMethodologyVersion:
      env.PUBLISHER_METHODOLOGY_VERSION ?? DEFAULT_METHODOLOGY_CONFIG.version,
    // Contributor/dispersion/band limits default to the pinned methodology's
    // per-panel values (panelOverrides included); an explicit env var is a
    // tighten-only override, never a relaxation of the methodology.
    minContributors:
      env.PUBLISHER_MIN_CONTRIBUTORS === undefined || env.PUBLISHER_MIN_CONTRIBUTORS === ""
        ? null
        : intEnv("PUBLISHER_MIN_CONTRIBUTORS", env.PUBLISHER_MIN_CONTRIBUTORS, 1),
    maxDispersion:
      env.PUBLISHER_MAX_DISPERSION === undefined || env.PUBLISHER_MAX_DISPERSION === ""
        ? null
        : numEnv("PUBLISHER_MAX_DISPERSION", env.PUBLISHER_MAX_DISPERSION, 0),
    maxFreshnessMs: intEnv("PUBLISHER_MAX_FRESHNESS_MS", env.PUBLISHER_MAX_FRESHNESS_MS, 300_000),
    maxJumpPct: numEnv("PUBLISHER_MAX_JUMP_PCT", env.PUBLISHER_MAX_JUMP_PCT, 0.25),
    maxBandWidthPct:
      env.PUBLISHER_MAX_BAND_WIDTH_PCT === undefined || env.PUBLISHER_MAX_BAND_WIDTH_PCT === ""
        ? null
        : numEnv("PUBLISHER_MAX_BAND_WIDTH_PCT", env.PUBLISHER_MAX_BAND_WIDTH_PCT, 0),
    // PROTOCOL.md §11 publication trigger: publish when the candidate
    // deviates from the last published value by at least this fraction
    // (90 bps), or at the heartbeat below — whichever first. Between
    // triggers the on-chain figure is already current and the tx is
    // suppressed (gas). Quality thresholds above only annotate.
    minDeviationPct: numEnv("PUBLISHER_MIN_DEVIATION_PCT", env.PUBLISHER_MIN_DEVIATION_PCT, 0.9),
    // §11 heartbeat: even without deviation, republish after this long so
    // on-chain updatedAt never goes stale while the price plateaus (~24h).
    heartbeatMs: intEnv("PUBLISHER_HEARTBEAT_MS", env.PUBLISHER_HEARTBEAT_MS, 86_400_000),
    // Robinhood Chain's slow gas tier sits below 0.1 gwei; oracle writes are
    // heartbeat-grade, not latency-sensitive, so pin the fee ceiling there
    // (converted to wei once, here) instead of taking viem's estimate.
    maxFeePerGasWei: gweiEnv("PUBLISHER_MAX_FEE_GWEI", env.PUBLISHER_MAX_FEE_GWEI, "0.05"),
    target,
    logLevel: env.LOG_LEVEL ?? "info",
    ...chainEnv(target, env),
  };
}
