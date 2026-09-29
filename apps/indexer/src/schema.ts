export interface Table {
  entity: string;
  id(value: Record<string, unknown>): string;
  bigintNumbers: readonly string[];
  /** Int! columns fed raw event args — envio decodes uint24/int24 params as
   *  JS bigint, and int4 columns reject it (the spike's "cannot cast type
   *  bigint to integer[]" failure). Scoped per table because "fee" is uint24
   *  on the v4 events (Int!) but uint256 on GUSD/issuance (BigInt!). */
  intNumbers: readonly string[];
  $inferInsert: any;
  $inferSelect: any;
}

function event(
  entity: string,
  bigintNumbers: readonly string[] = ["blockTimestamp"],
  intNumbers: readonly string[] = [],
): Table {
  return table(
    entity,
    (value) => `${value.blockNumber}_${value.logIndex}`,
    bigintNumbers,
    intNumbers,
  );
}

function table(
  entity: string,
  id: (value: Record<string, unknown>) => string,
  bigintNumbers: readonly string[] = [],
  intNumbers: readonly string[] = [],
): Table {
  return { entity, id, bigintNumbers, intNumbers, $inferInsert: undefined, $inferSelect: undefined };
}

export const gusdMinted = event("GusdMinted");
export const gusdRedeemed = event("GusdRedeemed");
export const sgusdDeposited = event("SgusdDeposited");
export const sgusdWithdrawn = event("SgusdWithdrawn");
export const sgusdSeeded = event("SgusdSeeded");
export const gpuCreated = event("GpuCreated");
export const gpuIssued = event("GpuIssued");
export const routerBuy = event("RouterBuy");
export const routerSell = event("RouterSell");
export const stableMintViaSwap = event("StableMintViaSwap");
export const stableRedeemViaSwap = event("StableRedeemViaSwap");
export const revenueDistributed = event("RevenueDistributed");
export const hookPoolRegistered = event("HookPoolRegistered");
export const hookSwap = event("HookSwap");
export const gpuFill = event("GpuFill");
export const priceConsumed = event("PriceConsumed", ["blockTimestamp", "observedAtSec"]);
export const signerTransferStarted = event("SignerTransferStarted");
export const signerAccepted = event("SignerAccepted");
export const pmPoolInitialized = event("PmPoolInitialized", ["blockTimestamp"], [
  "fee",
  "tick",
  "tickSpacing",
]);
export const pmSwap = event("PmSwap", ["blockTimestamp"], ["fee", "tick"]);
export const pmLiquidityModified = event("PmLiquidityModified");
export const pmDonate = event("PmDonate");
export const posmPositionModified = event("PosmPositionModified");
export const tokenTransfer = event("TokenTransfer");

// ---------------------------------------------------------------------------
// Perp engine (GpuPerpEngine) — log rows + state
// ---------------------------------------------------------------------------

export const sgusdEngineWithdrawal = event("SgusdEngineWithdrawal");
export const perpOrderCreated = event("PerpOrderCreated");
export const perpOrderExecuted = event("PerpOrderExecuted");
export const perpOrderCancelled = event("PerpOrderCancelled");
export const perpPositionIncreased = event("PerpPositionIncreased");
export const perpPositionDecreased = event("PerpPositionDecreased");
export const perpPositionClosed = event("PerpPositionClosed");
export const perpPositionLiquidated = event("PerpPositionLiquidated");
export const perpClaimableSettled = event("PerpClaimableSettled");
export const perpClaimed = event("PerpClaimed");
export const perpFundingAccrued = event("PerpFundingAccrued", [
  "blockTimestamp",
  "updatedAtSec",
]);

export const pools = table(
  "Pool",
  (value) => String(value.poolId),
  ["registeredAtSec", "swapCount", "lastSwapAtSec"],
  ["fee", "tickSpacing", "tick"],
);
export const gpuAssets = table("GpuAsset", (value) => String(value.gpuId), [
  "issuedCount",
  "firstIssuedAtSec",
  "lastIssuedAtSec",
  "buyCount",
  "sellCount",
  "lastTradeAtSec",
]);
export const gpuOracleState = table("GpuOracleState", (value) => String(value.gpuId), [
  "observedAtSec",
]);
export const gpuTokens = table("GpuToken", (value) => String(value.token));
export const walletBalances = table("WalletBalance", (value) => `${value.wallet}_${value.token}`, [
  "transferCount",
  "lastTransferAtSec",
]);
export const walletCostBasis = table("WalletCostBasis", (value) => `${value.wallet}_${value.gpuId}`, [
  "acquisitions",
  "disposals",
  "firstActivityAtSec",
  "lastActivityAtSec",
]);
export const walletVaultPositions = table("WalletVaultPosition", (value) => String(value.wallet), [
  "deposits",
  "withdraws",
  "firstActivityAtSec",
  "lastActivityAtSec",
]);
export const wallets = table("Wallet", (value) => String(value.address), ["eventCount"]);
export const userEvents = event("UserEvent");
export const poolStatsHourly = table(
  "PoolStatsHourly",
  (value) => `${value.poolId}_${value.bucketStart}`,
  ["bucketStart", "buys", "sells", "swaps"],
);
export const poolLiquidityPositions = table(
  "PoolLiquidityPosition",
  (value) => `${value.poolId}_${value.tickLower}_${value.tickUpper}_${value.salt}`,
  ["modifyCount", "firstModifiedAtSec", "lastModifiedAtSec"],
);
export const protocolStats = table("ProtocolStats", () => "protocol", [
  "mintCount",
  "redeemCount",
  "issuedCount",
  "buyCount",
  "sellCount",
  "maxObservationAgeSec",
  "epochLengthSec",
]);
export const sgusdVault = table("SgusdVault", () => "vault", ["depositCount", "withdrawCount"]);
export const protocolStatsDaily = table("ProtocolStatsDaily", (value) => String(value.bucketStart), [
  "bucketStart",
  "mintCount",
  "redeemCount",
  "issuedCount",
  "buyCount",
  "sellCount",
]);
export const perpMarkets = table("PerpMarket", (value) => String(value.gpuId), [
  "fundingUpdatedAtSec",
  "createdAtSec",
], ["maxLeverageBps", "maintenanceMarginBps", "openFeeBps", "closeFeeBps", "liquidationFeeBps", "fundingRatePpmPerSec", "borrowRatePpmPerSec"]);
export const perpPositions = table(
  "PerpPosition",
  (value) => `${value.wallet}_${value.gpuId}_${value.isLong}`,
  // Counts/timestamps round-trip as Numbers (JS-comparable, wallets.eventCount
  // precedent); money columns (size/collateral/entry/checkpoints/realizedPnl)
  // stay native BigInt through the read-back so the delta math is exact.
  ["openedAtSec", "lastTouchedAtSec", "closedAtSec", "liquidatedAtSec", "increaseCount", "decreaseCount"],
);
export const perpOrders = table("PerpOrder", (value) => String(value.orderId), [
  "orderId",
  "createdAtSec",
  "resolvedAtSec",
], ["kind", "status"]);
export const perpClaimable = table("PerpClaimable", (value) => String(value.wallet), [
  "settleCount",
  "claimCount",
  "lastActivityAtSec",
]);
export const perpEngineStats = table("PerpEngineStats", () => "engine", [
  "minOrderDelaySec",
  "orderCount",
  "liquidationCount",
  "settledGusd",
  "claimedGusd",
]);
