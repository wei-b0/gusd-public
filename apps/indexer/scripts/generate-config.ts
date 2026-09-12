import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadDeployment } from "../src/addresses.js";

const chainId = Number(process.env.INDEXER_CHAIN_ID ?? "31337");
if (![31337, 46630, 4663].includes(chainId)) {
  throw new Error(`INDEXER_CHAIN_ID must be 31337, 46630, or 4663, got "${chainId}"`);
}

const rpcUrl = process.env.INDEXER_RPC_URL?.trim()
  || (chainId === 31337 ? "http://127.0.0.1:8545" : undefined);
if (!rpcUrl && chainId !== 4663) throw new Error("INDEXER_RPC_URL is required");
if (chainId === 4663 && !process.env.ENVIO_API_TOKEN?.trim()) {
  throw new Error("ENVIO_API_TOKEN is required for chain 4663");
}
const pgSchema = process.env.ENVIO_PG_SCHEMA ?? "gusd_index_envio_dev_v1";
if (!/^gusd_index_envio_[a-z0-9_]+$/.test(pgSchema)) {
  throw new Error(`ENVIO_PG_SCHEMA must be a dedicated gusd_index_envio_* schema, got "${pgSchema}"`);
}

const deployment = await loadDeployment(
  { id: chainId, name: `chain${chainId}`, rpcUrl },
  process.env,
  process.env.INDEXER_OFFLINE_CODEGEN !== "1",
);
const address = deployment.addresses;
const events = {
  GUSD: ["Minted", "Redeemed", "FeesUpdated", "Transfer"],
  SgUSD: ["Deposit", "Withdraw", "Seeded", "Transfer"],
  GPUIssuance: ["GpuCreated", "Issued", "IssuanceEnabledSet", "IssuanceFeeSet", "MaxOracleStalenessSet"],
  GPUToken: ["Transfer"],
  GpuRouter: ["Buy", "Sell"],
  StableRouter: ["MintedViaSwap", "RedeemedViaSwap"],
  RevenueLedger: ["Distributed", "SplitUpdated", "RecipientsUpdated"],
  GPUMarketLiquidity: ["BidCredited", "GpuNoted", "InventoryPulled"],
  GPUHook: ["PoolRegistered", "HookSwap", "GpuFill", "HookFeeBpsSet"],
  GPUPriceOracle: ["PricePublished", "PriceOverridden", "PublisherAccepted", "MaxDeviationBpsSet"],
  PoolManager: ["Initialize", "Swap", "ModifyLiquidity", "Donate"],
  PositionManager: ["ModifyPosition"],
} as const;
const abiFiles: Record<keyof typeof events, string> = {
  GUSD: "abis/gusd.json",
  SgUSD: "abis/sgusd.json",
  GPUIssuance: "abis/issuance.json",
  GPUToken: "abis/gpu_token.json",
  GpuRouter: "abis/router.json",
  StableRouter: "abis/stable_router.json",
  RevenueLedger: "abis/ledger.json",
  GPUMarketLiquidity: "abis/market_liquidity.json",
  GPUHook: "abis/hook.json",
  GPUPriceOracle: "abis/oracle.json",
  PoolManager: "abis/pool_manager.json",
  PositionManager: "abis/position_manager.json",
};
const addresses: Partial<Record<keyof typeof events, string>> = {
  GUSD: address.gusd,
  SgUSD: address.sgusd,
  GPUIssuance: address.issuance,
  GpuRouter: address.router,
  StableRouter: address.stableRouter,
  RevenueLedger: address.ledger,
  GPUMarketLiquidity: address.marketLiquidity,
  GPUHook: address.hook,
  GPUPriceOracle: address.oracle,
  PoolManager: address.poolManager,
  PositionManager: address.positionManager,
};

const contracts = Object.keys(events).map((name) => ({
  name,
  abi_file_path: abiFiles[name as keyof typeof events],
  events: events[name as keyof typeof events].map((event) => ({ event })),
}));
const chainContracts = Object.keys(events).map((name) => ({
  name,
  ...(addresses[name as keyof typeof events] ? { address: addresses[name as keyof typeof events] } : {}),
}));
const config = {
  name: "gusd-indexer",
  schema: "schema.graphql",
  handlers: "src/handlers",
  disable_default_cross_chain: true,
  rollback_on_reorg: true,
  raw_events: false,
  address_format: "lowercase",
  bytes_type: "hex",
  field_selection: { transaction_fields: ["hash"] },
  storage: { postgres: { column_name_format: "snake_case" } },
  contracts,
  chains: [
    {
      id: chainId,
      start_block: deployment.startBlock,
      block_lag: 0,
      max_reorg_depth: chainId === 4663 ? 10000 : 200,
      ...(rpcUrl ? { rpc: [{ url: rpcUrl, for: chainId === 4663 ? "fallback" : "sync" }] } : {}),
      ...(chainId === 4663
        ? { hypersync_config: { url: "https://robinhood.hypersync.xyz" } }
        : {}),
      contracts: chainContracts,
    },
  ],
};

const output = path.resolve(process.cwd(), process.env.INDEXER_CONFIG_PATH ?? "config.yaml");
writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`);
writeFileSync(
  path.resolve(process.cwd(), "src/runtime-config.ts"),
  `export const CHAIN_ID: number = ${chainId};\nexport const PROTOCOL_ADDRESSES = ${JSON.stringify(addresses, null, 2)} as const;\nexport const CANONICAL_POOL_IDS: readonly string[] = ${JSON.stringify(deployment.canonicalPools.map((pool) => pool.poolId))};\n`,
);
