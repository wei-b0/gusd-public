import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The keeper's settings. The keeper is the one service that broadcasts
 * transactions it did not originate — its key is a funded hot EOA with no
 * protocol role (the engine pays it the escrowed execution fee; the engine's
 * permissionless execution is the authorization). Everything else is wired
 * like the attestor: local Postgres, the oracle API, and the deployment
 * record mounted read-only.
 */
export interface KeeperEnv {
  /** Hot EOA paying gas and receiving the escrowed execution fee. */
  privateKey: `0x${string}`;
  rpcUrl: string;
  chainId: number;
  /** Directory holding `<chainId>.json` deployment records (read-only mount in compose). */
  deploymentsDir: string;
  databaseUrl: string;
  /** The Envio entity schema the keeper reads the perp book from. */
  indexerSchema: string;
  /** The oracle API — attestation fetches (only when work exists). */
  oracleHttpUrl: string;
  /** The oracle candidate stream — the keeper's only tick source. */
  oracleWsUrl: string;
  /** Gas ceiling in gwei: candidates with a higher base fee wait, they do not burn the hot key. */
  maxFeeGwei: number;
  /** Health alarm threshold for the hot key's native balance. */
  minBalanceEth: number;
  /** Periodic full book reload (seconds) — the safety net under event-driven reconciliation. */
  reloadSec: number;
  /** Seconds of WS downtime before the SSE fallback stream takes over. */
  sseFallbackSec: number;
  logLevel: string;
}

function intEnv(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export function parseKeeperEnv(env: NodeJS.ProcessEnv = process.env): KeeperEnv {
  const privateKey = env.KEEPER_PRIVATE_KEY;
  if (!privateKey || !PRIVATE_KEY_RE.test(privateKey)) {
    throw new Error("KEEPER_PRIVATE_KEY must be a 32-byte hex private key");
  }
  const chainId = intEnv("KEEPER_CHAIN_ID", env.KEEPER_CHAIN_ID, 31337);
  return {
    privateKey: privateKey as `0x${string}`,
    rpcUrl: env.KEEPER_RPC_URL ?? "http://127.0.0.1:8545",
    chainId,
    // Compose mounts the record read-only; a host-run keeper resolves it
    // relative to the compiled file (dist/x.js → ../../contracts/deployments).
    deploymentsDir:
      env.KEEPER_DEPLOYMENTS_DIR ??
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../contracts/deployments"),
    databaseUrl: env.DATABASE_URL ?? "postgres://gusd:gusd@localhost:54329/gusd",
    indexerSchema: env.INDEXER_SCHEMA ?? "gusd_index_envio_docker_v2",
    oracleHttpUrl: env.ORACLE_HTTP_URL ?? "http://127.0.0.1:8080",
    oracleWsUrl: env.ORACLE_WS_URL ?? "ws://127.0.0.1:8080/v1/stream",
    maxFeeGwei: intEnv("KEEPER_MAX_FEE_GWEI", env.KEEPER_MAX_FEE_GWEI, 100),
    minBalanceEth: Number(env.KEEPER_MIN_BALANCE_ETH ?? "0.1"),
    reloadSec: intEnv("KEEPER_RELOAD_SEC", env.KEEPER_RELOAD_SEC, 30),
    sseFallbackSec: intEnv("KEEPER_SSE_FALLBACK_SEC", env.KEEPER_SSE_FALLBACK_SEC, 10),
    logLevel: env.LOG_LEVEL ?? "info",
  };
}

export interface DeploymentRecord {
  oracle: `0x${string}`;
  perpEngine: `0x${string}`;
  sgusd: `0x${string}`;
  gusd: `0x${string}`;
  chainId: number;
}

/** Reads `<dir>/<chainId>.json` — the one shared address record. A missing or
 *  engine-less record is a loud boot failure: a keeper without an engine
 *  would silently watch nothing. */
export function readDeploymentRecord(dir: string, chainId: number): DeploymentRecord {
  const file = path.join(dir, `${chainId}.json`);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`deployment record not found at ${file} — deploy first (err: ${String(err)})`);
  }
  const rec = JSON.parse(raw) as Partial<DeploymentRecord>;
  if (!rec.oracle || !rec.perpEngine || !rec.sgusd || !rec.gusd) {
    throw new Error(
      `deployment record ${file} lacks oracle/perpEngine/sgusd/gusd — redeploy with a perp-capable Deploy`,
    );
  }
  if (rec.chainId !== undefined && rec.chainId !== chainId) {
    throw new Error(`deployment record ${file} is for chain ${rec.chainId}, keeper configured for ${chainId}`);
  }
  return rec as DeploymentRecord;
}