/**
 * Deployment loader. Addresses come from apps/contracts/deployments/<id>.json
 * (written by script/Deploy.s.sol `_persist`); canonical pool ids are
 * deterministic — keccak256(abi.encode(currency0, currency1, fee,
 * tickSpacing, hooks)) — and are computed at config load so the PoolManager
 * and PositionManager sources can be FILTERED at fetch time on their indexed
 * `id` argument (rev 2 decision: a shared PoolManager must not cost the
 * whole chain's v4 log volume).
 *
 * Derivation inputs are stable onchain facts: pool fee/tickSpacing are fixed
 * at createGpu (never mutated), and the hook for every protocol pool is the
 * one GPUHook. GPUHook.PoolRegistered remains the authoritative canonicality
 * signal for the derived `pools.canonical` flag — the filter is the fetch-time
 * optimization, the flag is the persisted guard.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  encodeAbiParameters,
  http,
  isAddress,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { issuanceReadAbi } from "./abis.js";
import type { IndexerChain } from "./env.js";

export interface IndexerAddresses {
  gusd: Address;
  sgusd: Address;
  hook: Address;
  issuance: Address;
  ledger: Address;
  oracle: Address;
  router: Address;
  stableRouter: Address;
  marketLiquidity: Address;
  poolManager: Address;
  positionManager: Address;
}

export interface CanonicalPool {
  /** Left-aligned ASCII bytes32, lowercase 0x-prefixed. */
  gpuId: Hex;
  /** keccak256(abi.encode(poolKey)) — the v4 PoolId. */
  poolId: Hex;
}

export interface LoadedDeployment {
  chainId: number;
  addresses: IndexerAddresses;
  /** First block worth scanning (deployment JSON `startBlock`). */
  startBlock: number;
  canonicalPools: CanonicalPool[];
  /** Where the pool ids came from — for the boot log. */
  poolsSource: "deployment-json" | "derived-onchain";
}

interface RawDeployment {
  chainId: number;
  startBlock?: number;
  pools?: { gpuId: string; poolId: string }[];
  gusd: string;
  sgusd: string;
  hook: string;
  issuance: string;
  ledger: string;
  oracle: string;
  router: string;
  stableRouter: string;
  marketLiquidity: string;
  poolManager: string;
  positionManager: string;
}

/** Locate apps/contracts/deployments from this package's position in the
 *  workspace, falling back to a walk up from cwd (containers set
 *  INDEXER_DEPLOYMENTS_DIR instead of relying on layout). */
export function findDeploymentsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.INDEXER_DEPLOYMENTS_DIR;
  if (override !== undefined && override.trim() !== "") {
    if (!existsSync(override)) {
      throw new Error(`INDEXER_DEPLOYMENTS_DIR does not exist: "${override}"`);
    }
    return override;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../contracts/deployments"), // src → apps/indexer/src → apps/contracts
    path.resolve(here, "../../../contracts/deployments"), // dist → apps/indexer/dist → apps/contracts
  ];
  let dir = path.resolve(process.cwd());
  for (let i = 0; i < 6; i += 1) {
    candidates.push(path.join(dir, "apps", "contracts", "deployments"));
    candidates.push(path.join(dir, "contracts", "deployments"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Could not locate apps/contracts/deployments — set INDEXER_DEPLOYMENTS_DIR to the absolute path`,
  );
}

function requireAddress(raw: string, field: string, chainId: number): Address {
  if (!isAddress(raw)) {
    throw new Error(`deployments/${chainId}.json field "${field}" is not an address: "${raw}"`);
  }
  return raw as Address;
}

function loadDeploymentJson(chainId: number, deploymentsDir: string): RawDeployment {
  const file = path.join(deploymentsDir, `${chainId}.json`);
  if (!existsSync(file)) {
    throw new Error(
      `No deployment for chain ${chainId}: ${file} is missing. Run Deploy.s.sol on that chain first.`,
    );
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as RawDeployment;
  if (raw.chainId !== chainId) {
    throw new Error(`deployments/${chainId}.json declares chainId ${raw.chainId} — refusing to load`);
  }
  return raw;
}

/** Pool id = keccak256(abi.encode(poolKey)) — exactly v4's PoolId.wrap in
 *  PoolKey.toId() (v4-core types/PoolId.sol); abi.encode of the struct is
 *  the concatenation of its five static members. */
export function derivePoolId(poolKey: {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
    ),
  );
}

function normalizeHex32(raw: string, field: string): Hex {
  const value = raw.toLowerCase() as Hex;
  if (!/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${field} is not a bytes32 hex string: "${raw}"`);
  }
  return value;
}

const ADDRESS_FIELDS = [
  "gusd",
  "sgusd",
  "hook",
  "issuance",
  "ledger",
  "oracle",
  "router",
  "stableRouter",
  "marketLiquidity",
  "poolManager",
  "positionManager",
] as const satisfies readonly (keyof IndexerAddresses)[];

function requireAddresses(raw: RawDeployment, chainId: number): IndexerAddresses {
  const addresses = {} as IndexerAddresses;
  for (const field of ADDRESS_FIELDS) {
    const value: string | undefined = raw[field];
    if (typeof value !== "string") {
      throw new Error(`deployments/${chainId}.json is missing required field "${field}"`);
    }
    addresses[field] = requireAddress(value, field, chainId);
  }
  return addresses;
}

/** Boot-time derivation: issuance.gpuIds() → tokenOf + poolParamsOf per GPU
 *  → keccak256(abi.encode(poolKey)). Two state reads per GPU, once per boot. */
export async function deriveCanonicalPools(
  client: PublicClient,
  addresses: IndexerAddresses,
): Promise<CanonicalPool[]> {
  const gpuIds = (await client.readContract({
    address: addresses.issuance,
    abi: issuanceReadAbi,
    functionName: "gpuIds",
  })) as readonly Hex[];

  const pools = await Promise.all(
    gpuIds.map(async (gpuId) => {
      const [gpuToken, params] = await Promise.all([
        client.readContract({
          address: addresses.issuance,
          abi: issuanceReadAbi,
          functionName: "tokenOf",
          args: [gpuId],
        }) as Promise<Address>,
        client.readContract({
          address: addresses.issuance,
          abi: issuanceReadAbi,
          functionName: "poolParamsOf",
          args: [gpuId],
        }) as Promise<[number, number]>,
      ]);
      const [fee, tickSpacing] = params;
      const gusdIsCurrency0 = addresses.gusd.toLowerCase() < gpuToken.toLowerCase();
      return {
        gpuId: normalizeHex32(gpuId, `issuance.gpuIds() entry`),
        poolId: derivePoolId({
          currency0: gusdIsCurrency0 ? addresses.gusd : gpuToken,
          currency1: gusdIsCurrency0 ? gpuToken : addresses.gusd,
          fee,
          tickSpacing,
          hooks: addresses.hook,
        }),
      };
    }),
  );
  return pools;
}

function canonicalPoolsFromJson(raw: RawDeployment, chainId: number): CanonicalPool[] | null {
  if (raw.pools === undefined) return null;
  if (!Array.isArray(raw.pools)) {
    throw new Error(`deployments/${chainId}.json "pools" must be an array of {gpuId, poolId}`);
  }
  return raw.pools.map((p) => ({
    gpuId: normalizeHex32(p.gpuId, `pools[].gpuId`),
    poolId: normalizeHex32(p.poolId, `pools[].poolId`),
  }));
}

export async function loadDeployment(
  chain: IndexerChain,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedDeployment> {
  const deploymentsDir = findDeploymentsDir(env);
  const raw = loadDeploymentJson(chain.id, deploymentsDir);
  const addresses = requireAddresses(raw, chain.id);

  // startBlock: the JSON value written by Deploy.s.sol `_persist` is the
  // simulation-time block minus one — strictly below every deployment event.
  // A missing value is tolerable only on throwaway local chains; on anything
  // real it would silently scan from genesis.
  let startBlock: number;
  if (raw.startBlock !== undefined) {
    if (!Number.isInteger(raw.startBlock) || raw.startBlock < 0) {
      throw new Error(`deployments/${chain.id}.json "startBlock" must be a non-negative integer`);
    }
    startBlock = raw.startBlock;
  } else if (chain.id === 31337) {
    startBlock = 0;
  } else {
    throw new Error(
      `deployments/${chain.id}.json is missing "startBlock" — redeploy with the updated Deploy.s.sol or add it by hand (indexing from 0 on a real chain is not acceptable)`,
    );
  }

  const fromJson = canonicalPoolsFromJson(raw, chain.id);
  let canonicalPools: CanonicalPool[];
  let poolsSource: LoadedDeployment["poolsSource"];
  if (fromJson !== null && fromJson.length > 0) {
    canonicalPools = fromJson;
    poolsSource = "deployment-json";
  } else {
    const client = createPublicClient({ transport: http(chain.rpcUrl) });
    canonicalPools = await deriveCanonicalPools(client, addresses);
    poolsSource = "derived-onchain";
  }

  return { chainId: chain.id, addresses, startBlock, canonicalPools, poolsSource };
}
