/**
 * Ponder source configuration. Runs through vite-node with top-level await,
 * so the boot-time canonical-pool derivation (an eth_call round-trip per GPU)
 * completes before Ponder compiles its sources.
 *
 * The `contracts` object is written as a LITERAL (keys and ABIs intact): the
 * typed handler registry (`ponder.on("GPUHook:PoolRegistered")`) is derived
 * from this type statically — accumulating into a Record<string, …> widens
 * the ABIs and collapses the registry to `:setup` only. Per-chain fragments
 * flow through the generic `perChain` helper, preserving their inferred
 * shapes (including the literal filter event names).
 *
 * Canonicality model (rev 2):
 *   1. Fetch-time: PoolManager/PositionManager sources carry a source-level
 *      `filter` on their indexed `id` argument, listing the canonical pool
 *      ids derived here — a shared PoolManager costs only gUSD pools' logs.
 *   2. Persisted: `pools.canonical` (set by GPUHook.PoolRegistered) is the
 *      secondary guard handlers check through context.db — no in-memory
 *      state anywhere, so canonicality survives reorgs and restarts.
 *
 * When a GPU is created AFTER the indexer last derived its pool ids, its
 * PoolRegistered arrives for a pool id outside the filter: the pools row
 * keeps currency0 NULL (the ops signal), and the runbook is to redeploy the
 * indexer (fresh deployment schema) with recomputed ids.
 */

import { createConfig, factory } from "ponder";
import { http, type Hex } from "viem";
import {
  gpuCreatedEvent,
  gusdAbi,
  hookAbi,
  issuanceAbi,
  ledgerAbi,
  marketLiquidityAbi,
  oracleAbi,
  poolManagerAbi,
  positionManagerAbi,
  routerAbi,
  sgusdAbi,
  stableRouterAbi,
  gpuTokenAbi,
} from "./src/abis.js";
import { loadDeployment, type IndexerAddresses } from "./src/addresses.js";
import { parseIndexerEnv } from "./src/env.js";

// Fails loudly unless DATABASE_SCHEMA / DATABASE_VIEWS_SCHEMA are present in
// the process env — Ponder's CLI resolves its namespace BEFORE this file
// runs, so a missing schema env would silently land every table in "public".
// .env.local (loaded by the CLI) or real env vars are the sources of truth.
const env = parseIndexerEnv(process.env);

interface ChainFragment {
  name: string;
  startBlock: number;
  addresses: IndexerAddresses;
  poolIds: Hex[];
}

// Per-chain fragments: namespace + deployment facts only. Contract shapes
// stay literal below.
const chains: Record<string, { id: number; rpc: ReturnType<typeof http> }> = {};
const fragments: ChainFragment[] = [];

for (const chain of env.chains) {
  const deployment = await loadDeployment(chain);
  const { addresses, canonicalPools, poolsSource } = deployment;

  chains[chain.name] = {
    id: chain.id,
    rpc: http(chain.rpcUrl),
    ...(chain.maxBlockRange !== undefined ? { ethGetLogsBlockRange: chain.maxBlockRange } : {}),
  };
  fragments.push({
    name: chain.name,
    startBlock: deployment.startBlock,
    addresses,
    poolIds: canonicalPools.map((p) => p.poolId),
  });

  console.log(
    `[indexer] chain ${chain.id}: ${canonicalPools.length} canonical pool(s) from ${poolsSource}, startBlock ${deployment.startBlock}`,
  );
}

/** Deeply map `const`-inferred types back to mutable form: literal scalars
 *  (filter event names) stay literal, readonly tuples become mutable arrays —
 *  the shape Ponder's source config expects. */
type Widen<T> = T extends readonly (infer U)[]
  ? Widen<U>[]
  : T extends object
    ? { [K in keyof T]: Widen<T[K]> }
    : T;

/** Fan one chain fragment out into the chain-keyed network map, preserving
 *  the builder's inferred shape (literal event names in filters, Factory
 *  objects in `address`). */
function perChain<const T>(make: (f: ChainFragment) => T): Record<string, Widen<T>> {
  return Object.fromEntries(fragments.map((f) => [f.name, make(f)])) as unknown as Record<
    string,
    Widen<T>
  >;
}

const config = createConfig({
  ordering: "multichain",
  database: { kind: "postgres", connectionString: env.databaseUrl },
  chains,
  contracts: {
    GUSD: { abi: gusdAbi, chain: perChain((f) => ({ address: f.addresses.gusd, startBlock: f.startBlock })) },
    sgUSD: { abi: sgusdAbi, chain: perChain((f) => ({ address: f.addresses.sgusd, startBlock: f.startBlock })) },
    GPUIssuance: {
      abi: issuanceAbi,
      chain: perChain((f) => ({ address: f.addresses.issuance, startBlock: f.startBlock })),
    },
    // GPUTokens are real child contracts — the one legitimate factory use:
    // their address rides in GpuCreated.token. (Factory is the `address`
    // variant in Ponder's network config, not a separate key.)
    GPUToken: {
      abi: gpuTokenAbi,
      chain: perChain((f) => ({
        address: factory({ address: f.addresses.issuance, event: gpuCreatedEvent, parameter: "token" }),
        startBlock: f.startBlock,
      })),
    },
    GpuRouter: { abi: routerAbi, chain: perChain((f) => ({ address: f.addresses.router, startBlock: f.startBlock })) },
    StableRouter: {
      abi: stableRouterAbi,
      chain: perChain((f) => ({ address: f.addresses.stableRouter, startBlock: f.startBlock })),
    },
    RevenueLedger: {
      abi: ledgerAbi,
      chain: perChain((f) => ({ address: f.addresses.ledger, startBlock: f.startBlock })),
    },
    GPUMarketLiquidity: {
      abi: marketLiquidityAbi,
      chain: perChain((f) => ({
        address: f.addresses.marketLiquidity,
        startBlock: f.startBlock,
      })),
    },
    GPUHook: { abi: hookAbi, chain: perChain((f) => ({ address: f.addresses.hook, startBlock: f.startBlock })) },
    GPUPriceOracle: {
      abi: oracleAbi,
      chain: perChain((f) => ({ address: f.addresses.oracle, startBlock: f.startBlock })),
    },
    // The v4 singleton is shared on live chains — filter every event at the
    // source on the indexed pool `id` so non-protocol pools cost nothing.
    PoolManager: {
      abi: poolManagerAbi,
      chain: perChain((f) => ({
        address: f.addresses.poolManager,
        startBlock: f.startBlock,
        filter: [
          { event: "Initialize", args: { id: f.poolIds } },
          { event: "Swap", args: { id: f.poolIds } },
          { event: "ModifyLiquidity", args: { id: f.poolIds } },
          { event: "Donate", args: { id: f.poolIds } },
        ],
      })),
    },
    PositionManager: {
      abi: positionManagerAbi,
      chain: perChain((f) => ({
        address: f.addresses.positionManager,
        startBlock: f.startBlock,
        filter: [
          { event: "ModifyPosition", args: { id: f.poolIds } },
          { event: "Transfer", args: {} },
        ],
      })),
    },
  },
});

export default config;
