/**
 * Event-only ABIs, hand-checked against the forge artifacts in
 * apps/contracts/out/ (2026-09). The full artifact ABIs are build outputs and
 * PoolManager's drags hundreds of unused items into the bundler — so the
 * indexer carries exactly the events it indexes. If a contract emits a new
 * event version, the forge artifact diff is the source of truth for updating
 * these (an out-of-sync ABI fails loudly: Ponder cannot decode unknown topic
 * hashes and logs the mismatch).
 */

import { parseAbi, parseAbiItem } from "viem";

/** gUSD — Minted/Redeemed user flows, fees config, raw transfers. */
export const gusdAbi = parseAbi([
  "event Minted(address indexed to, uint256 underlyingIn, uint256 gusdOut, uint256 fee)",
  "event Redeemed(address indexed from, uint256 gusdIn, uint256 underlyingOut, uint256 fee)",
  "event FeesUpdated(uint16 mintFeeBps, uint16 redeemFeeBps)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** sgUSD — ERC4626 stake/unstake, vault seeding, raw transfers. */
export const sgusdAbi = parseAbi([
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
  "event Seeded(uint256 assets)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** GPUIssuance — GPU registration, primary issuance, issuance config. */
export const issuanceAbi = parseAbi([
  "event GpuCreated(bytes32 indexed gpuId, address token, uint16 feeBps, uint24 poolFee, int24 tickSpacing)",
  "event Issued(address indexed caller, bytes32 indexed gpuId, address indexed to, uint256 amount, uint256 base, uint256 fee)",
  "event IssuanceEnabledSet(bytes32 indexed gpuId, bool enabled)",
  "event IssuanceFeeSet(bytes32 indexed gpuId, uint16 feeBps)",
  "event MaxOracleStalenessSet(uint256 seconds_)",
]);

/** GPUToken — child tokens discovered via factory on GpuCreated.token. */
export const gpuTokenAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** GpuRouter — routed executions (pool leg + issuance leg). */
export const routerAbi = parseAbi([
  "event Buy(bytes32 indexed gpuId, address indexed recipient, address indexed payer, uint256 gpuOut, uint256 paid, uint256 poolGpuOut, uint256 issueGpuOut, uint256 hookFee, uint256 issuanceFee)",
  "event Sell(bytes32 indexed gpuId, address indexed recipient, uint256 gpuIn, uint256 out, uint256 hookFee)",
]);

/** StableRouter — stable funding flows into/out of gUSD. StableUpdated
 *  (whitelist config, no consumer) is deliberately not fetched. */
export const stableRouterAbi = parseAbi([
  "event MintedViaSwap(address indexed stable, address indexed to, uint256 amountIn, uint256 underlyingOut, uint256 gusdOut)",
  "event RedeemedViaSwap(address indexed stable, address indexed to, uint256 gusdIn, uint256 underlyingIn, uint256 stableOut)",
]);

/** RevenueLedger — sgUSD/treasury revenue splits. */
export const ledgerAbi = parseAbi([
  "event Distributed(uint256 amount, uint256 toVault, uint256 toTreasury)",
  "event SplitUpdated(uint16 sgUSDBps)",
  "event RecipientsUpdated(address vault, address treasury)",
]);

/** GPUHook — canonical pool registration + gUSD trading-fee capture. */
export const hookAbi = parseAbi([
  "event PoolRegistered(bytes32 indexed poolId, bytes32 indexed gpuId)",
  "event TradingFeeAccrued(bytes32 indexed poolId, bytes32 indexed gpuId, bool indexed isBuy, uint256 gusdFee)",
  "event TradingFeesHarvested(bytes32 indexed poolId, uint256 amount)",
  "event HookFeeBpsSet(uint16 oldFeeBps, uint16 newFeeBps)",
]);

/** GPUMarketLiquidity (POL) — oracle-anchored bid/ask bands funded by
 *  primary principal. RefsSet (one-shot wiring, no consumer) and
 *  PrincipalPending (redundant with Issued.base — the issuance handler
 *  already accumulates principalContributedGusd) are deliberately not
 *  fetched. */
export const marketLiquidityAbi = parseAbi([
  "event BandPlaced(bytes32 indexed gpuId, bytes32 indexed poolId, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 gusdPlaced, uint256 gpuPlaced, bool bidSide)",
  "event BandRemoved(bytes32 indexed gpuId, bytes32 indexed poolId, int24 tickLower, int24 tickUpper, uint256 recoveredGusd, uint256 recoveredGpu)",
  "event Recentred(bytes32 indexed gpuId, uint256 bandsRemoved, uint256 gusdRecovered, uint256 gpuRecovered)",
  "event FeesCollected(bytes32 indexed gpuId, uint256 gusdToLedger, uint256 gpuToInventory)",
]);

/** GPUPriceOracle — onchain publications (transparency/comparison only).
 *  PublisherTransferStarted (two-step-own intermediate step, no consumer)
 *  is deliberately not fetched. */
export const oracleAbi = parseAbi([
  "event PricePublished(bytes32 indexed gpuId, uint256 price, uint256 updatedAt, uint256 previousPrice)",
  "event PriceOverridden(bytes32 indexed gpuId, uint256 price, uint256 updatedAt)",
  "event PublisherAccepted(address indexed previousPublisher, address indexed newPublisher)",
  "event MaxDeviationBpsSet(uint16 bps)",
]);

/** IPoolManager — v4 singleton pool lifecycle, filtered to canonical pool ids. */
export const poolManagerAbi = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
  "event Donate(bytes32 indexed id, address indexed sender, uint256 amount0, uint256 amount1)",
]);

/** IPositionManager — v4-periphery LP flow; sender is the unlock locker (end user).
 *  Transfer is the solmate ERC-721 form (verified against
 *  lib/v4-periphery/src/base/ERC721Permit_v4.sol → solmate ERC721), not ERC-6909. */
export const positionManagerAbi = parseAbi([
  "event ModifyPosition(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed id)",
]);

/** Read-only surface the address loader derives canonical pool ids from
 *  (apps/contracts/src/GPUIssuance.sol — gpuIds() at line 227, PoolParams
 *  fixed at createGpu, never mutated). */
export const issuanceReadAbi = parseAbi([
  "function gpuIds() view returns (bytes32[])",
  "function poolParamsOf(bytes32 gpuId) view returns (uint24, int24)",
  "function tokenOf(bytes32 gpuId) view returns (address)",
]);

/** The GpuCreated event object the GPUToken factory watches. */
export const gpuCreatedEvent = parseAbiItem(
  "event GpuCreated(bytes32 indexed gpuId, address token, uint16 feeBps, uint24 poolFee, int24 tickSpacing)",
);
