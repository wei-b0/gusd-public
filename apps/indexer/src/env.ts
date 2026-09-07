/**
 * Indexer environment validation. Fail loudly at boot, never half-configure —
 * same doctrine as apps/oracle/src/env.ts.
 *
 * Schema contract (verified against ponder@0.17.9 bin/commands): the CLI
 * resolves the namespace BEFORE the config file executes —
 *   schema     = --schema flag ?? process.env.DATABASE_SCHEMA ?? "public" (dev)
 *   viewsSchema= --views-schema flag ?? process.env.DATABASE_VIEWS_SCHEMA    (start)
 * `ponder dev` additionally forces viewsSchema to undefined (views are a
 * `ponder start` feature). Writing to "public" is never acceptable — it would
 * spray the indexer's tables next to the market-data tables and its
 * gusd_forbid_mutation() triggers — so DATABASE_SCHEMA / DATABASE_VIEWS_SCHEMA
 * are REQUIRED (set them in .env.local, which the CLI loads before boot, or in
 * the process env). The INDEXER_* names are accepted aliases; setting both
 * spellings is fatal.
 *
 * Environments are one-chain-per-process: dev indexes Anvil, testnet indexes
 * Robinhood testnet, mainnet indexes Robinhood mainnet. Multichain indexing
 * of unrelated chains together has no consumer and doubles the RPC budget.
 */

export interface IndexerChain {
  id: number;
  /** Ponder source name (used as `Contract:Event` prefix in handlers). */
  name: string;
  rpcUrl: string;
  /** Optional override for eth_getLogs block ranges (rate-limited endpoints). */
  maxBlockRange?: number;
}

export interface IndexerEnv {
  databaseUrl: string;
  /** Per-deployment Ponder schema, e.g. `gusd_index_dev_v1`. */
  deploymentSchema: string;
  /** Stable views schema Fastify reads, e.g. `gusd_index_dev` (start only). */
  viewsSchema: string;
  chains: IndexerChain[];
}

/** Deployment JSON lives in the contracts app; overridable for containers. */
const CHAIN_NAMES: Record<number, string> = {
  31337: "anvil",
  46630: "robinhoodTestnet",
  4663: "robinhoodMainnet",
};

function chainName(chainId: number): string {
  return CHAIN_NAMES[chainId] ?? `chain${chainId}`;
}

function schemaEnv(ponderName: string, aliasName: string, raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      `${ponderName} is required (alias: ${aliasName}). Set it in .env.local or the process env — ` +
        `without it Ponder falls back to the "public" schema, which the indexer must never write to.`,
    );
  }
  const value = raw.trim();
  if (!/^[a-z_][a-z0-9_]{0,44}$/.test(value)) {
    throw new Error(
      `${ponderName} must match [a-z_][a-z0-9_]{0,44} (Ponder caps object names at 45 chars), got "${value}"`,
    );
  }
  return value;
}

function requireSchemaPair(
  env: NodeJS.ProcessEnv,
  ponderName: string,
  aliasName: string,
): string {
  const ponderValue = env[ponderName];
  const aliasValue = env[aliasName];
  if (
    ponderValue !== undefined &&
    aliasValue !== undefined &&
    ponderValue.trim() !== aliasValue.trim()
  ) {
    throw new Error(
      `Both ${ponderName}="${ponderValue}" and ${aliasName}="${aliasValue}" are set with different values — pick one spelling`,
    );
  }
  return schemaEnv(ponderName, aliasName, ponderValue ?? aliasValue);
}

function positiveInt(name: string, raw: string): number {
  const v = Number(raw);
  if (!Number.isInteger(v) || v <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return v;
}

export function parseIndexerEnv(env: NodeJS.ProcessEnv = process.env): IndexerEnv {
  const databaseUrl =
    env.INDEXER_DATABASE_URL ?? env.DATABASE_URL ?? "postgres://gusd:gusd@localhost:54329/gusd";

  const deploymentSchema = requireSchemaPair(env, "DATABASE_SCHEMA", "INDEXER_DEPLOYMENT_SCHEMA");
  const viewsSchema = requireSchemaPair(env, "DATABASE_VIEWS_SCHEMA", "INDEXER_VIEWS_SCHEMA");
  if (deploymentSchema === viewsSchema) {
    throw new Error(
      `Deployment schema and views schema must differ (Ponder refuses them equal): "${deploymentSchema}"`,
    );
  }

  const chainsRaw = env.INDEXER_CHAINS ?? "31337";
  const chainIds = chainsRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((s) => {
      const id = Number(s);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`INDEXER_CHAINS entries must be positive integers, got "${s}"`);
      }
      return id;
    });
  if (chainIds.length === 0) {
    throw new Error(`INDEXER_CHAINS is empty — name at least one chain to index`);
  }
  if (new Set(chainIds).size !== chainIds.length) {
    throw new Error(`INDEXER_CHAINS contains duplicate chain ids: "${chainsRaw}"`);
  }

  const chains: IndexerChain[] = chainIds.map((id) => {
    const rpcName = `INDEXER_RPC_URL_${id}`;
    const rpcUrl = env[rpcName];
    if (rpcUrl === undefined || rpcUrl.trim() === "") {
      throw new Error(
        `${rpcName} is required for every chain in INDEXER_CHAINS (chain ${id} has none)`,
      );
    }
    const maxBlockRangeRaw = env[`INDEXER_MAX_BLOCK_RANGE_${id}`];
    return {
      id,
      name: chainName(id),
      rpcUrl: rpcUrl.trim(),
      // Empty string = unset (compose environment blocks pass empties
      // through for optional vars).
      maxBlockRange:
        maxBlockRangeRaw !== undefined && maxBlockRangeRaw.trim() !== ""
          ? positiveInt(`INDEXER_MAX_BLOCK_RANGE_${id}`, maxBlockRangeRaw)
          : undefined,
    };
  });

  return { databaseUrl, deploymentSchema, viewsSchema, chains };
}
