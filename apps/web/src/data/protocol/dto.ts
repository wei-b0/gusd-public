/**
 * Wire DTOs for the oracle's /v1/protocol/* routes — key-for-key mirrors of
 * apps/oracle/src/protocol/dto.ts (that file is the single source; changes
 * there land here verbatim). Amounts are decimal strings (raw units: gUSD
 * 6-dec, GPU 18-dec, sqrtPriceX96/liquidity as stored); counts, block/log
 * numbers, chain ids and epoch-seconds timestamps are JSON numbers.
 * IndexedEvent itself is NOT duplicated — it is the wire contract already
 * pinned in src/domain/indexer.ts.
 */

// --- wallet balances ---------------------------------------------------------

export interface WalletBalanceDto {
  chainId: number;
  /** Lowercase token address — the app maps it to gUSD/sgUSD/GPUToken via
   *  its own contract set, never by name here. */
  token: string;
  /** Raw units as a decimal string. */
  balance: string;
  transferCount: number;
  lastTransferAtSec: number | null;
  lastTransferBlockNumber: number | null;
}

export interface WalletBalancesBody {
  balances: WalletBalanceDto[];
}

// --- wallet positions (cost basis, rev-2 gated) ---------------------------------

export interface WalletPositionDto {
  chainId: number;
  gpuId: string;
  /** Raw GPU units (18-dec) — the attributable quantity. */
  qtyGpu: string;
  /** Raw gUSD (6-dec) attributable cost. */
  costGusd: string;
  /** `complete` = basis attributable from protocol events alone. */
  basisState: string;
  /** gUSD (6-dec) per 1 GPU — null unless basisState is complete and the
   *  position is open: "—" beats precise wrong math. */
  avgEntryGusd: string | null;
  /** Raw gUSD (6-dec) realized. Null when basis is incomplete. */
  realizedPnlGusd: string | null;
  /** Present exactly when a gated field is null, naming why. */
  reason: string | null;
  acquisitions: number;
  disposals: number;
  firstActivityAtSec: number | null;
  lastActivityAtSec: number | null;
}

export interface WalletVaultPositionDto {
  chainId: number;
  /** Raw sgUSD shares (6-dec — same grain as the gUSD asset). */
  shares: string;
  /** Raw gUSD (6-dec) attributable deposit cost. */
  assetsCost: string;
  basisState: string;
  /** gUSD (6-dec) per 1 sgUSD — same completeness gate as GPU positions. */
  avgEntryAssets: string | null;
  realizedPnlGusd: string | null;
  reason: string | null;
  deposits: number;
  withdraws: number;
  firstActivityAtSec: number | null;
  lastActivityAtSec: number | null;
}

export interface WalletPositionsBody {
  positions: WalletPositionDto[];
  vault: WalletVaultPositionDto | null;
}

// --- routed executions (never merged with the AMM swap tape) ----------------------

export interface ExecutionDto {
  /** `buy` = GpuRouter.Buy (pool leg + issuance leg); `sell` = GpuRouter.Sell. */
  side: "buy" | "sell";
  chainId: number;
  blockNumber: number;
  logIndex: number;
  txHash: string;
  /** Chain settlement time, epoch seconds. */
  blockTimestampSec: number;
  gpuId: string;
  /** The wallet the execution belongs to (the recipient). */
  wallet: string;
  /** Buy only — who funded it (may differ from the wallet). */
  payer: string | null;
  /** Buy: gpuOut; sell: gpuIn. Raw GPU units (18-dec). */
  gpuAmount: string;
  /** Buy: paid all-in; sell: out proceeds. Raw gUSD (6-dec). */
  gUsdAmount: string;
  /** POL fee on the execution's hook fills, raw gUSD (6-dec). */
  polFeeGusd: string;
  /** Buy only — the genesis-fallback issuance fee, raw gUSD (6-dec). */
  issuanceFeeGusd: string | null;
  /** Hook trading fee attached to the execution, raw gUSD (6-dec). */
  hookFeeGusd: string;
}

export interface ExecutionsBody {
  executions: ExecutionDto[];
  nextCursor?: string;
}

// --- pools (AMM execution state, notion 3) ----------------------------------------

export interface PoolDto {
  chainId: number;
  poolId: string;
  gpuId: string | null;
  canonical: boolean;
  registeredBlockNumber: number | null;
  registeredAtSec: number | null;
  currency0: string | null;
  currency1: string | null;
  fee: number | null;
  tickSpacing: number | null;
  hooks: string | null;
  gusdIsCurrency0: boolean | null;
  sqrtPriceX96: string | null;
  tick: number | null;
  liquidity: string | null;
  swapCount: number;
  volumeGusd: string;
  buyVolumeGusd: string;
  sellVolumeGusd: string;
  hookFeesGusd: string;
  lpFeesGusdEst: string;
  lastSwapAtSec: number | null;
  lastSwapBlockNumber: number | null;
  /** AMM EXECUTION STATE derived from sqrtPriceX96 — one of the four price
   *  notions; never a market or display price. Deliberately unconsumed in
   *  the web app (the depth figure comes from liquidity directly). */
  ammPriceGusd: string | null;
}

export interface PoolsBody {
  pools: PoolDto[];
}

// --- pool stats buckets (hourly — the only stored grain) ----------------------------

export interface PoolStatsBucketDto {
  bucketStart: number;
  volumeGusd: string;
  buyVolumeGusd: string;
  sellVolumeGusd: string;
  buys: number;
  sells: number;
  hookFeesGusd: string;
  lpFeesGusdEst: string;
  swaps: number;
}

export interface PoolStatsBody {
  intervalSec: 3600;
  buckets: PoolStatsBucketDto[];
}

// --- AMM swap tape -------------------------------------------------------------------

export interface SwapTapeDto {
  chainId: number;
  blockNumber: number;
  logIndex: number;
  blockTimestampSec: number;
  poolId: string;
  sender: string;
  /** The swapper's signed deltas, verbatim (hook fee excluded by v4). */
  amount0: string;
  amount1: string;
  /** `buy` ⇔ the swapper paid gUSD. Null when the pool's currency ordering
   *  is unknown. */
  side: "buy" | "sell" | null;
  /** Absolute gUSD-side delta, raw 6-dec. Null with `side`. */
  gusdAmount: string | null;
  sqrtPriceX96: string;
  liquidity: string;
  tick: number;
  fee: number;
}

export interface SwapsBody {
  swaps: SwapTapeDto[];
  nextCursor?: string;
}

// --- GPU assets -------------------------------------------------------------------

export interface GpuCatalogDto {
  id: string;
  label: string;
  vendor: string;
  vramGb: number;
}

export interface GpuAssetDto {
  chainId: number;
  gpuId: string;
  gpuSku: string;
  token: string;
  issuanceFeeBps: number;
  issuanceEnabled: boolean;
  poolFee: number;
  tickSpacing: number;
  canonicalPoolId: string | null;
  issuedGpu: string;
  issuedCount: number;
  issuanceProceedsGusd: string;
  issuanceFeesGusd: string;
  principalContributedGusd: string;
  /** POL bid-side gUSD inventory (buyable sell depth, honestly finite). */
  polGusd: string;
  /** POL ask-side GPU inventory. */
  polGpu: string;
  /** Σ GpuFill.protocolFee on this market. */
  polFeesGusd: string;
  firstIssuedAtSec: number | null;
  lastIssuedAtSec: number | null;
  buyCount: number;
  sellCount: number;
  volumeGusd: string;
  lastTradeAtSec: number | null;
  /** Catalog metadata joined at the API boundary — never chain data. */
  catalog: GpuCatalogDto | null;
}

export interface GpusBody {
  gpus: GpuAssetDto[];
}

// --- protocol aggregates ----------------------------------------------------------

export interface ProtocolStatsDto {
  chainId: number;
  gusdMintedGusd: string;
  gusdRedeemedGusd: string;
  mintCount: number;
  redeemCount: number;
  issuedGpu: string;
  issuedCount: number;
  issuanceProceedsGusd: string;
  issuanceFeesGusd: string;
  buyCount: number;
  sellCount: number;
  buyVolumeGusd: string;
  sellVolumeGusd: string;
  hookFeesGusd: string;
  lpFeesGusdEst: string;
  revenueDistributedGusd: string;
  revenueToVaultGusd: string;
  revenueToTreasuryGusd: string;
  mintFeeBps: number | null;
  redeemFeeBps: number | null;
  hookFeeBps: number | null;
  maxOracleStalenessSec: number | null;
  maxDeviationBps: number | null;
  sgusdSplitBps: number | null;
  vault: string | null;
  treasury: string | null;
  publisher: string | null;
}

export interface SgusdVaultDto {
  chainId: number;
  seededGusd: string;
  depositsGusd: string;
  withdrawsGusd: string;
  sharesMinted: string;
  sharesBurned: string;
  depositCount: number;
  withdrawCount: number;
  revenueGusd: string;
}

export interface StatsBody {
  stats: ProtocolStatsDto | null;
  vault: SgusdVaultDto | null;
}

// --- indexed oracle state (transparency only, NEVER a display price) -----------------

export interface OracleStateDto {
  chainId: number;
  gpuId: string;
  /** The onchain published value — USD/GPU-hr × 10_000 (PRICE_SCALE).
   *  Transparency/health/comparison ONLY; never rendered as a number. */
  price: string | null;
  previousPrice: string | null;
  updatedAtSec: number | null;
  overriddenPrice: string | null;
  overriddenAtSec: number | null;
  lastPublishedBlockNumber: number | null;
  /** Fixed interpretation constant for `price`. */
  priceScale: 10_000;
  /** Serving-time age of the publication — a live computation at the API
   *  boundary, never indexed state. */
  ageSec: number | null;
  /** vs the protocol's maxOracleStalenessSec config mirror. */
  staleness: "fresh" | "stale" | "unknown";
}

export interface OraclePublicationDto {
  chainId: number;
  blockNumber: number;
  logIndex: number;
  blockTimestampSec: number;
  gpuId: string;
  price: string;
  previousPrice: string;
  updatedAtSec: number;
}

export interface OracleStateBody {
  oracle: OracleStateDto | null;
  history?: OraclePublicationDto[];
}
