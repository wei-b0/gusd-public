/**
 * Self-contained anvil harness for the gated indexer suites (RUN_ANVIL_TESTS=1).
 *
 * The suite owns its whole stack: a PRIVATE anvil (never the shared dev node —
 * reorg tests must be free to revert the chain), a THROWAWAY copy of
 * apps/contracts in /tmp (so `forge script Deploy` cannot clobber the real
 * apps/contracts/deployments/31337.json the dev stack points at), its own
 * forge churn, and its own `ponder start` instances in scratch schemas.
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
  "gusd_index_e2e_a",
  "gusd_index_e2e_b",
  "gusd_index_e2e_c",
  "gusd_index_e2e_d",
  "gusd_index_e2e_e",
  "gusd_index_e2e_rot",
];

export interface PonderInstance {
  proc: ChildProcess;
  baseUrl: string;
  schema: string;
  viewsSchema: string;
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

export interface SpawnPonderOptions {
  schema: string;
  viewsSchema: string;
  port: number;
}

/** Boots `ponder start` in a scratch schema and waits for /ready (200 =
 *  backfill complete + realtime on all chains). */
export async function spawnPonder(opts: SpawnPonderOptions): Promise<PonderInstance> {
  const proc = spawn(path.join(INDEXER_DIR, "node_modules/.bin/ponder"), ["start"], {
    cwd: INDEXER_DIR,
    env: {
      ...process.env,
      DATABASE_URL,
      DATABASE_SCHEMA: opts.schema,
      DATABASE_VIEWS_SCHEMA: opts.viewsSchema,
      INDEXER_RPC_URL_31337: ANVIL_URL,
      // The suite chain's deployment is the COPY's (fresh Deploy there) — the
      // repo's deployments/31337.json describes the DEV chain and its
      // addresses don't exist on the private anvil, which fails the boot-time
      // canonical-pool derivation (gpuIds() → 0x).
      INDEXER_DEPLOYMENTS_DIR: path.join(prepareContractsCopy(), "deployments"),
      PORT: String(opts.port),
      PONDER_LOG_LEVEL: "warn",
    },
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
      output += `\n[ponder exited ${code}]\n`;
    }
  });
  const instance: PonderInstance = {
    proc,
    baseUrl,
    schema: opts.schema,
    viewsSchema: opts.viewsSchema,
    output,
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
        const res = await fetch(`${baseUrl}/ready`);
        return res.ok;
      } catch {
        return false;
      }
    },
    { timeoutMs: 180_000, label: `ponder ready (${opts.schema})`, failOutput: () => instance.output },
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

/** Ponder's checkpoint composite is {timestamp(10)}{chainId(16)}{blockNumber(16)}…,
 *  the blockNumber segment being a zero-padded decimal. The 999…999 sentinel
 *  ("indexed through infinity") parses as 0 here — which is exactly the state
 *  /ready fires in on anvil, see waitForCaughtUp. */
export async function ponderProcessedBlock(client: pg.Client, schema: string): Promise<number> {
  const res = await client.query<{ latest_checkpoint: string }>(
    `select latest_checkpoint from "${schema}"._ponder_checkpoint where chain_name = 'anvil'`,
  );
  const checkpoint = res.rows[0]?.latest_checkpoint ?? "";
  if (checkpoint.length < 42) return -1;
  return Number(checkpoint.slice(26, 42));
}

/**
 * /ready is NOT a data barrier on anvil: with no finality ponder's backfill
 * range is [startBlock, finalized] = [0, 0] — a no-op — and ready fires while
 * live indexing has not yet walked to the boot head (observed: ready with
 * zero rows, then history indexed over the following seconds). So: mine one
 * empty block and wait until ponder's live checkpoint passes it. Live
 * indexing walks blocks sequentially, so passing the new head guarantees the
 * entire history landed in this instance's schema.
 */
export async function waitForCaughtUp(inst: PonderInstance, client: pg.Client): Promise<void> {
  await anvilRpc("evm_mine", []);
  const head = Number(BigInt(await anvilRpc<string>("eth_blockNumber", [])));
  await waitFor(
    async () => (await ponderProcessedBlock(client, inst.schema)) >= head,
    {
      timeoutMs: 120_000,
      label: `ponder caught up to mined head ${head} (${inst.schema})`,
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

/** Dumps every chain-derived table of a deployment schema to a canonical
 *  (key-sorted, row-sorted) JSON string per table — the byte-identical
 *  comparison substrate for the determinism tests. Ponder's own bookkeeping
 *  (_ponder_meta/_ponder_checkpoint/_reorg__*) is excluded: it tracks
 *  process progress, not chain-derived state. */
export async function dumpSchema(client: pg.Client, schema: string): Promise<TableDump> {
  const tables = await client.query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = $1 and table_type = 'BASE TABLE'
       and table_name not like '%ponder%' and table_name not like '%reorg%'`,
    [schema],
  );
  const dump: TableDump = {};
  for (const { table_name } of tables.rows) {
    const rows = await client.query(`select * from "${schema}"."${table_name}"`);
    const canonical = rows.rows
      .map((r) => canonicalJson(r))
      .sort()
      .join("\n");
    dump[table_name] = canonical;
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

/** The view schema's stored definition for one view — which deployment the
 *  views currently re-point to. */
export async function viewDefinition(client: pg.Client, viewsSchema: string, view: string): Promise<string> {
  const res = await client.query<{ definition: string }>(
    `select definition from pg_views where schemaname = $1 and viewname = $2`,
    [viewsSchema, view],
  );
  return res.rows[0]?.definition ?? "";
}

/** Tears the suite's world down: processes, tmp contracts copy, scratch schemas. */
export async function teardown(
  client: pg.Client | null,
  instances: PonderInstance[],
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
