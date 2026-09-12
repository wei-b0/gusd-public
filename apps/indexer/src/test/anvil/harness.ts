/**
 * Self-contained anvil harness for the gated indexer suites (RUN_ANVIL_TESTS=1).
 *
 * The suite owns its whole stack: a PRIVATE anvil (never the shared dev node —
 * reorg tests must be free to revert the chain), a THROWAWAY copy of
 * apps/contracts in /tmp (so `forge script Deploy` cannot clobber the real
 * apps/contracts/deployments/31337.json the dev stack points at), its own
 * forge churn, and its own Envio instances in scratch schemas.
 * Nothing here touches the dev deployment schema, the dev views, or public.*.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
export const INDEXER_DIR = path.resolve(here, "../../.."); // src/test/anvil → apps/indexer
export const REPO_ROOT = path.resolve(INDEXER_DIR, "../..");

export const ANVIL_URL = "http://127.0.0.1:18545";
export const ANVIL_PORT = 18545;
export const DATABASE_URL = "postgres://gusd:gusd@localhost:54329/gusd";
/** Anvil's default mnemonic account 0 — the deployer AND the oracle publisher. */
export const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** Scratch schemas the suite owns; dropped before and after each run. */
export const SCRATCH_SCHEMAS = [
  "gusd_index_envio_e2e_a",
  "gusd_index_envio_e2e_b",
  "gusd_index_envio_e2e_c",
  "gusd_index_envio_e2e_d",
  "gusd_index_envio_e2e_e",
  "gusd_index_envio_e2e_rot",
];

export interface EnvioInstance {
  proc: ChildProcess;
  baseUrl: string;
  schema: string;
  output: string;
  kill(): Promise<void>;
}

async function spawnAndCollect(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; output: string }> {
  const proc = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout?.on("data", (d: Buffer) => {
    output += d.toString();
  });
  proc.stderr?.on("data", (d: Buffer) => {
    output += d.toString();
  });
  return await new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code, output }));
  });
}

let anvilProc: ChildProcess | null = null;
let anvilOutput = "";

/** Boots the suite's private anvil; refuses to reuse a busy port. */
export async function spawnAnvil(): Promise<void> {
  try {
    const probe = await fetch(ANVIL_URL, { method: "POST", body: JSON.stringify({ method: "eth_chainId" }) });
    if (probe !== null) {
      throw new Error(`port ${ANVIL_PORT} already serves an anvil — the suite needs its own node`);
    }
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("fetch failed")) throw err;
  }
  // NOTE: no --block-time. Interval mining hangs `forge script --broadcast`
  // forever in its receipt-wait loop (receipts exist on-chain; forge never
  // accepts them). Auto-mine (default) broadcasts Deploy+Demo in seconds and
  // the suite's reorg/live tests don't need periodic empty blocks.
  anvilProc = spawn("anvil", ["--port", String(ANVIL_PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  anvilProc.stdout?.on("data", (d: Buffer) => {
    anvilOutput += d.toString();
  });
  anvilProc.stderr?.on("data", (d: Buffer) => {
    anvilOutput += d.toString();
  });
  await waitFor(
    async () => {
      try {
        await anvilRpc("eth_chainId", []);
        return true;
      } catch {
        return false;
      }
    },
    { timeoutMs: 30_000, label: "anvil boot" },
  );
}

/** JSON-RPC against the private anvil. */
export async function anvilRpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(ANVIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method} failed: ${body.error.message}`);
  return body.result as T;
}

export async function evmSnapshot(): Promise<string> {
  return anvilRpc<string>("evm_snapshot", []);
}

export async function evmRevert(snapshotId: string): Promise<void> {
  await anvilRpc("evm_revert", [snapshotId]);
}

let contractsCopy: string | null = null;

/** Copies apps/contracts to /tmp so `forge script Deploy` writes its
 *  deployments/<id>.json THERE, never into the repo the dev stack reads.
 *  out/ and lib/ ship along: forge replays cached artifacts without
 *  recompiling, and nested lib test sources (HookMiner, solmate mocks) are
 *  real script dependencies. Only broadcast/ logs are dropped. */
export function prepareContractsCopy(): string {
  if (contractsCopy !== null) return contractsCopy;
  const tmp = path.join(os.tmpdir(), `gusd-indexer-e2e-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  cpSync(path.join(REPO_ROOT, "apps/contracts"), tmp, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}broadcast`),
  });
  contractsCopy = tmp;
  return tmp;
}

/** Runs one forge script against the private anvil from the contracts copy. */
export async function runForgeScript(script: string, sig?: string): Promise<void> {
  const dir = prepareContractsCopy();
  const { code, output } = await spawnAndCollect(
    "forge",
    [
      "script",
      script,
      ...(sig !== undefined ? ["--sig", sig] : []),
      "--rpc-url",
      ANVIL_URL,
      "--broadcast",
    ],
    { cwd: dir, env: { ...process.env, PRIVATE_KEY: DEPLOYER_PK } },
  );
  if (code !== 0) {
    throw new Error(`forge script ${script} failed (${code}):\n${output.slice(-4000)}`);
  }
}

/** deployments/<id>.json from the COPY (never the repo file). */
export function readDeployment(chainId = 31337): Record<string, string | number> {
  return JSON.parse(
    readFileSync(path.join(prepareContractsCopy(), "deployments", `${chainId}.json`), "utf8"),
  ) as Record<string, string | number>;
}

export interface SpawnEnvioOptions {
  schema: string;
  port: number;
}

/** Boots Envio in a scratch schema and waits for committed readiness. */
export async function spawnEnvio(opts: SpawnEnvioOptions): Promise<EnvioInstance> {
  const runtimeEnv = {
    ...process.env,
    ENVIO_PG_HOST: "127.0.0.1",
    ENVIO_PG_PORT: "54329",
    ENVIO_PG_USER: "gusd",
    ENVIO_PG_PASSWORD: "gusd",
    ENVIO_PG_DATABASE: "gusd",
    ENVIO_PG_SCHEMA: opts.schema,
    ENVIO_PG_SSL_MODE: "false",
    ENVIO_HASURA: "false",
    ENVIO_INDEXER_PORT: String(opts.port),
    INDEXER_CHAIN_ID: "31337",
    INDEXER_RPC_URL: ANVIL_URL,
    INDEXER_DEPLOYMENTS_DIR: path.join(prepareContractsCopy(), "deployments"),
    LOG_LEVEL: "warn",
  };
  const generated = await spawnAndCollect("pnpm", ["config:generate"], {
    cwd: INDEXER_DIR,
    env: runtimeEnv,
  });
  if (generated.code !== 0) {
    throw new Error(`Envio config generation failed (${generated.code}):\n${generated.output}`);
  }
  const proc = spawn(path.join(INDEXER_DIR, "node_modules/.bin/envio"), ["start"], {
    cwd: INDEXER_DIR,
    env: runtimeEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout?.on("data", (d: Buffer) => {
    output += d.toString();
  });
  proc.stderr?.on("data", (d: Buffer) => {
    output += d.toString();
  });
  const baseUrl = `http://127.0.0.1:${opts.port}`;
  proc.on("close", (code) => {
    if (code !== null && code !== 0) {
      output += `\n[envio exited ${code}]\n`;
    }
  });
  const instance: EnvioInstance = {
    proc,
    baseUrl,
    schema: opts.schema,
    get output() {
      return output;
    },
    kill: async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill("SIGTERM");
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => proc.once("close", () => resolve(true))),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
      ]);
      if (!exited) proc.kill("SIGKILL");
    },
  };
  await waitFor(
    async () => {
      try {
        const res = await fetch(`${baseUrl}/metrics`);
        const metrics = await res.text();
        return res.ok && /envio_progress_ready\{chainId="31337"\}\s+1/.test(metrics);
      } catch {
        return false;
      }
    },
    { timeoutMs: 180_000, label: `envio ready (${opts.schema})`, failOutput: () => instance.output },
  );
  const waiter = new pg.Client({ connectionString: DATABASE_URL });
  await waiter.connect();
  try {
    await waitForCaughtUp(instance, waiter);
  } finally {
    await waiter.end();
  }
  return instance;
}

/** Reads Envio's committed progress metric for the private chain. */
export async function envioProcessedBlock(inst: EnvioInstance): Promise<number> {
  const response = await fetch(`${inst.baseUrl}/metrics`);
  if (!response.ok) return -1;
  const metrics = await response.text();
  const match = metrics.match(/envio_progress_block\{chainId="31337"\}\s+([^\s]+)/);
  return match ? Number(match[1]) : -1;
}

/**
 * Readiness alone is not a data barrier on Anvil: with no finality Envio's backfill
 * range is [startBlock, finalized] = [0, 0] — a no-op — and ready fires while
 * live indexing has not yet walked to the boot head (observed: ready with
 * zero rows, then history indexed over the following seconds). So: mine one
 * empty block and wait until Envio's committed progress passes it. Live
 * indexing walks blocks sequentially, so passing the new head guarantees the
 * entire history landed in this instance's schema.
 */
export async function waitForCaughtUp(inst: EnvioInstance, _client: pg.Client): Promise<void> {
  await anvilRpc("evm_mine", []);
  const head = Number(BigInt(await anvilRpc<string>("eth_blockNumber", [])));
  await waitFor(
    async () => (await envioProcessedBlock(inst)) >= head,
    {
      timeoutMs: 120_000,
      label: `envio caught up to mined head ${head} (${inst.schema})`,
      failOutput: () => inst.output,
    },
  );
}

export async function waitFor(fn: () => Promise<boolean>, opts: { timeoutMs: number; label: string; failOutput?: () => string }): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) {
      const tail = opts.failOutput?.() ?? "";
      throw new Error(`waitFor timeout: ${opts.label}${tail ? `\n--- tail ---\n${tail.slice(-3000)}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function connectPg(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  return client;
}

export type TableDump = Record<string, string>;

const ENTITY_TABLES = [
  "GpuAsset", "GpuCreated", "GpuFill", "GpuIssued", "GpuToken", "GusdMinted",
  "GusdRedeemed", "HookPoolRegistered", "HookSwap", "OraclePriceOverridden",
  "OraclePricePublished", "OraclePublisherAccepted", "OracleState", "PmDonate",
  "PmLiquidityModified", "PmPoolInitialized", "PmSwap", "Pool",
  "PoolLiquidityPosition", "PoolStatsHourly", "PosmPositionModified", "ProtocolStats",
  "ProtocolStatsDaily", "RevenueDistributed", "RouterBuy", "RouterSell",
  "SgusdDeposited", "SgusdSeeded", "SgusdVault", "SgusdWithdrawn",
  "StableMintViaSwap", "StableRedeemViaSwap", "TokenTransfer", "UserEvent", "Wallet",
  "WalletBalance", "WalletCostBasis", "WalletVaultPosition",
] as const;

/** Dumps every chain-derived table of a deployment schema to a canonical
 *  (key-sorted, row-sorted) JSON string per table — the byte-identical
 *  comparison substrate for the determinism tests. Envio's bookkeeping is
 *  excluded because it tracks
 *  process progress, not chain-derived state. */
export async function dumpSchema(client: pg.Client, schema: string): Promise<TableDump> {
  const dump: TableDump = {};
  for (const tableName of ENTITY_TABLES) {
    const rows = await client.query(`select * from "${schema}"."${tableName}"`);
    const canonical = rows.rows
      .map((r) => canonicalJson(r))
      .sort()
      .join("\n");
    dump[tableName] = canonical;
  }
  return dump;
}

/** Stable JSON: object keys sorted recursively, so jsonb round-trips equal. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => [k, canonicalJson(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(",")}}`;
}

export function expectDumpsEqual(a: TableDump, b: TableDump, label: string): void {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (JSON.stringify(aKeys) !== JSON.stringify(bKeys)) {
    throw new Error(
      `${label}: table sets differ\nonly in a: ${aKeys.filter((k) => !bKeys.includes(k))}\nonly in b: ${bKeys.filter((k) => !aKeys.includes(k))}`,
    );
  }
  for (const key of aKeys) {
    if (a[key] !== b[key]) {
      const aRows = a[key] ? a[key].split("\n") : [];
      const bRows = b[key] ? b[key].split("\n") : [];
      const onlyA = aRows.filter((r) => !bRows.includes(r)).slice(0, 3);
      const onlyB = bRows.filter((r) => !aRows.includes(r)).slice(0, 3);
      throw new Error(
        `${label}: table "${key}" differs\nonly in a: ${JSON.stringify(onlyA)}\nonly in b: ${JSON.stringify(onlyB)}`,
      );
    }
  }
}

/** Tears the suite's world down: processes, tmp contracts copy, scratch schemas. */
export async function teardown(
  client: pg.Client | null,
  instances: EnvioInstance[],
): Promise<void> {
  for (const inst of instances) await inst.kill();
  if (client !== null) await client.end();
  anvilProc?.kill("SIGTERM");
  anvilProc = null;
  if (contractsCopy !== null) rmSync(contractsCopy, { recursive: true, force: true });
  contractsCopy = null;
}

export async function dropScratchSchemas(client: pg.Client): Promise<void> {
  for (const schema of SCRATCH_SCHEMAS) {
    await client.query(`drop schema if exists "${schema}" cascade`);
  }
}
