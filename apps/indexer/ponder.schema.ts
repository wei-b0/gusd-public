/**
 * The indexer's read model — fully owned by the Ponder runtime, isolated in
 * its own Postgres schema (gusd_index_<env>_v<n> per deployment, exposed to
 * Fastify through the stable gusd_index_<env> views schema).
 *
 * Ownership note (rev 2): event/history tables are append-only FROM INDEXING
 * LOGIC only — the Ponder runtime freely updates and deletes rows in every
 * table here for reorg rollback, crash recovery, and deployment management.
 * The gusd_forbid_mutation() append-only triggers stay confined to the
 * public.* market-data tables and are deliberately NOT mirrored here.
 *
 * Determinism note: every column is chain-derived. There is no wall-clock
 * column anywhere; `blockTimestamp` is the chain time the event settled at,
 * and the Fastify boundary maps it to the wire contract's seenAtMs.
 *
 * Types: `t.bigint` is Ponder's numeric(78) (full uint256 range, JS bigint);
 * `t.int8({mode:"number"})` is PG bigint for epoch-seconds and counters that
 * stay well under 2^53; `t.hex` is text, lowercased on write; `t.integer`
 * covers block numbers, ticks, and fees.
 */

import {
  index,
  int8,
  integer,
  onchainEnum,
  onchainTable,
  primaryKey,
} from "ponder";

/** Cost-basis completeness (rev 2): `complete` = basis is attributable from
 *  protocol events alone; `partial` = a raw token transfer touched the
 *  wallet; `unknown` = pre-history or unverifiable flow. The API refuses to
 *  print avgEntry/PnL unless `complete` — precise wrong math is worse than "—". */
export const basisState = onchainEnum("basis_state", [
  "complete",
  "partial",
  "unknown",
]);

/** Common columns on every event/history table — a factory, never a shared
 *  builder instance (drizzle builders are single-use per table). */
const eventColumns = () => ({
  chainId: integer("chain_id").notNull(),
  blockNumber: integer("block_number").notNull(),
  logIndex: integer("log_index").notNull(),
  blockTimestamp: int8("block_timestamp", { mode: "number" }).notNull(),
});

/** The event-table primary key: (chainId, blockNumber, logIndex). */
type EventTableColumns = { chainId: any; blockNumber: any; logIndex: any };
const eventPk = (table: EventTableColumns) =>
  primaryKey({ columns: [table.chainId, table.blockNumber, table.logIndex] });

// ---------------------------------------------------------------------------
// Event/history tables — one row per emitted log, insert-only from handlers
// ---------------------------------------------------------------------------

/** GUSD.Minted — user leg (StableRouter.mint calls gUSD.mint internally, so
 *  stable-funded mints surface here too, never double-counted). */
export const gusdMinted = onchainTable(
  "gusd_minted",
  (t) => ({
    ...eventColumns(),
    user: t.hex().notNull(),
    underlyingIn: t.bigint().notNull(),
    gusdOut: t.bigint().notNull(),
    fee: t.bigint().notNull(),
  }),
  (table) => ({
    pk: eventPk(table),
    gusd_minted_user_idx: index("gusd_minted_user_idx").on(
      table.chainId,
      table.user,
      table.blockNumber,
    ),
  }),
);

/** GUSD.Redeemed. */
export const gusdRedeemed = onchainTable(
  "gusd_redeemed",
  (t) => ({
    ...eventColumns(),
    user: t.hex().notNull(),
    gusdIn: t.bigint().notNull(),
    underlyingOut: t.bigint().notNull(),
    fee: t.bigint().notNull(),
  }),
  (table) => ({
    pk: eventPk(table),
    gusd_redeemed_user_idx: index("gusd_redeemed_user_idx").on(
      table.chainId,
      table.user,
      table.blockNumber,
    ),
  }),
);

/** sgUSD.Deposit — stake. Seed deposits carry owner = sgUSD contract; the
 *  API filters contract addresses from wallet-facing surfaces. */
export const sgusdDeposited = onchainTable(
  "sgusd_deposited",
  (t) => ({
    ...eventColumns(),
    sender: t.hex().notNull(),
    owner: t.hex().notNull(),
    assets: t.bigint().notNull(),
    shares: t.bigint().notNull(),
  }),
  (table) => ({
    pk: eventPk(table),
    sgusd_deposited_owner_idx: index("sgusd_deposited_owner_idx").on(
      table.chainId,
      table.owner,
      table.blockNumber,
    ),
  }),
);

/** sgUSD.Withdraw — unstake. */
export const sgusdWithdrawn = onchainTable(
  "sgusd_withdrawn",
  (t) => ({
    ...eventColumns(),
    sender: t.hex().notNull(),
    receiver: t.hex().notNull(),
    owner: t.hex().notNull(),
    assets: t.bigint().notNull(),
    shares: t.bigint().notNull(),
  }),
  (table) => ({
    pk: eventPk(table),
    sgusd_withdrawn_owner_idx: index("sgusd_withdrawn_owner_idx").on(
      table.chainId,
      table.owner,
      table.blockNumber,
    ),
  }),
);

/** sgUSD.Seeded — the one-way vault bootstrap. */
export const sgusdSeeded = onchainTable(
  "sgusd_seeded",
  (t) => ({
    ...eventColumns(),
    assets: t.bigint().notNull(),
  }),
  (table) => ({ pk: eventPk(table) }),
);

/** GPUIssuance.GpuCreated — GPU registration (metadata joins from
 *  @gusd/gpu-catalog at the API; the chain carries only ids and params). */
export const gpuCreated = onchainTable(
  "gpu_created",
  (t) => ({
    ...eventColumns(),
    gpuId: t.hex().notNull(),
    gpuSku: t.text().notNull(),
    token: t.hex().notNull(),
    feeBps: t.integer().notNull(),
    poolFee: t.integer().notNull(),
    tickSpacing: t.integer().notNull(),
  }),
  (table) => ({ pk: eventPk(table) }),
);

/** GPUIssuance.Issued — primary-market acquisition. cost = base + fee. */
export const gpuIssued = onchainTable(
  "gpu_issued",
  (t) => ({
    ...eventColumns(),
    caller: t.hex().notNull(),
    gpuId: t.hex().notNull(),
    user: t.hex().notNull(),
    amount: t.bigint().notNull(),
    base: t.bigint().notNull(),
    fee: t.bigint().notNull(),
  }),
  (table) => ({
    pk: eventPk(table),
    gpu_issued_gpu_idx: index("gpu_issued_gpu_idx").on(
      table.chainId,
      table.gpuId,
      table.blockNumber,
    ),
    gpu_issued_user_idx: index("gpu_issued_user_idx").on(
      table.chainId,
      table.user,
      table.blockNumber,
    ),
  }),
);

/** GpuRouter.Buy — routed execution filled by the hook's single composed
 *  swap (native LP flow + POL inventory + issuance backstop). The source
 *  decomposition lives in gpu_fill joined on tx hash; the fee fields are the
 *  hook's counter deltas over the swap (0 on the genesis fallback path,
 *  which still carries issuanceFee). */
export const routerBuy = onchainTable(
  "router_buy",
  (t) => ({
    ...eventColumns(),
    gpuId: t.hex().notNull(),
    recipient: t.hex().notNull(),
    payer: t.hex().notNull(),
    gpuOut: t.bigint().notNull(),
    paid: t.bigint().notNull(),
    polFeeGusd: t.bigint("pol_fee_gusd").notNull(),
    hookFeeGusd: t.bigint("hook_fee_gusd").notNull(),
    issuanceFee: t.bigint("issuance_fee").notNull(),
  }),
  (table) => ({
    pk: eventPk(table),
    router_buy_gpu_idx: index("router_buy_gpu_idx").on(
      table.chainId,
      table.gpuId,
      table.blockNumber,
    ),
    router_buy_recipient_idx: index("router_buy_recipient_idx").on(
      table.chainId,
      table.recipient,
      table.blockNumber,
    ),
  }),
);

/** GpuRouter.Sell — routed disposal (hook fills at the bid edge; the POL
 *  and gUSD hook fees come off the payout). */
export const routerSell = onchainTable(
  "router_sell",
  (t) => ({
    ...eventColumns(),
    gpuId: t.hex().notNull(),
    recipient: t.hex().notNull(),
    gpuIn: t.bigint().notNull(),
    out: t.bigint().notNull(),
    polFeeGusd: t.bigint("pol_fee_gusd").notNull(),
    hookFeeGusd: t.bigint("hook_fee_gusd").notNull(),
  }),
  (table) => ({
    pk: eventPk(table),
    router_sell_gpu_idx: index("router_sell_gpu_idx").on(
      table.chainId,
      table.gpuId,
      table.blockNumber,
    ),
    router_sell_recipient_idx: index("router_sell_recipient_idx").on(
      table.chainId,
      table.recipient,
      table.blockNumber,
    ),
  }),
);

/** StableRouter.MintedViaSwap — stable → underlying → gUSD. The gUSD leg
 *  also emits GUSD.Minted (user = `to`); this row is the funding-side view. */
export const stableMintViaSwap = onchainTable(
  "stable_mint_via_swap",
  (t) => ({
    ...eventColumns(),
    stable: t.hex().notNull(),
    user: t.hex().notNull(),
    amountIn: t.bigint().notNull(),
    underlyingOut: t.bigint().notNull(),
    gusdOut: t.bigint().notNull(),
  }),
  (table) => ({ pk: eventPk(table) }),
);

/** StableRouter.RedeemedViaSwap — gUSD → underlying → stable. */
export const stableRedeemViaSwap = onchainTable(
  "stable_redeem_via_swap",
  (t) => ({
    ...eventColumns(),
    stable: t.hex().notNull(),
    user: t.hex().notNull(),
    gusdIn: t.bigint().notNull(),
    underlyingIn: t.bigint().notNull(),
    stableOut: t.bigint().notNull(),
  }),
  (table) => ({ pk: eventPk(table) }),
);

/** RevenueLedger.Distributed — revenue split to sgUSD vault + treasury. */
export const revenueDistributed = onchainTable(
  "revenue_distributed",
  (t) => ({
    ...eventColumns(),
    amount: t.bigint().notNull(),
    toVault: t.bigint().notNull(),
    toTreasury: t.bigint().notNull(),
  }),
  (table) => ({ pk: eventPk(table) }),
);

/** GPUHook.PoolRegistered — the authoritative canonicality signal. */
export const hookPoolRegistered = onchainTable(
  "hook_pool_registered",
  (t) => ({
    ...eventColumns(),
    poolId: t.hex().notNull(),
    gpuId: t.hex().notNull(),
  }),
  (table) => ({ pk: eventPk(table) }),
);

/** GPUHook.HookSwap (URC-2 shape) — one row per hook-contributing swap, in
 *  swapper-view signed deltas (positive = the swapper received that
 *  currency from hook fills). None on quotes/sims/reverts or pure-native
 *  swaps. The in-lock `sender` is the PoolManager (the true swapper is not
 *  identifiable without spoofable hookData) — join GpuFill to the core Swap
 *  on tx hash for attribution. */
export const hookSwap = onchainTable(
  "hook_swap",
  (t) => ({
    ...eventColumns(),
    poolId: t.hex().notNull(),
    sender: t.hex().notNull(),
    amount0: t.bigint().notNull(),
    amount1: t.bigint().notNull(),
    swapFee: t.integer("swap_fee").notNull(),
  }),
  (table) => ({
    pk: eventPk(table),
    hook_swap_pool_idx: index("hook_swap_pool_idx").on(
      table.chainId,
      table.poolId,
      table.blockNumber,
    ),
  }),
);

/** GPUHook.GpuFill — one row per protocol fill source inside a hook swap.
 *  `source`: 0 = POL inventory, 1 = issuance backstop. `gusdAmount` is the
 *  gUSD the hook took in (buy) or paid out (sell) for that fill, GROSS of
 *  `protocolFee` (the POL/issuance fee on the fill; the buy-side in-kind
 *  GPU fee is taken off the delivered GPU and never touches gUSD). `sender`
 *  is the PoolManager — the router Buy/Sell events attribute the trade to
 *  the wallet. */
export const gpuFill = onchainTable(
  "gpu_fill",
  (t) => ({
    ...eventColumns(),
    poolId: t.hex().notNull(),
    gpuId: t.hex().notNull(),
    sender: t.hex().notNull(),
    isBuy: t.boolean().notNull(),
    gpuAmount: t.bigint("gpu_amount").notNull(),
    gusdAmount: t.bigint("gusd_amount").notNull(),
    protocolFee: t.bigint("protocol_fee").notNull(),
    source: t.integer().notNull(),
  }),
  (table) => ({
    pk: eventPk(table),
    gpu_fill_gpu_idx: index("gpu_fill_gpu_idx").on(
      table.chainId,
      table.gpuId,
      table.blockNumber,
    ),
    gpu_fill_pool_idx: index("gpu_fill_pool_idx").on(
      table.chainId,
      table.poolId,
      table.blockNumber,
    ),
  }),
);

/** GPUPriceOracle.PricePublished — transparency/health/comparison ONLY;
 *  never a frontend price source (the canonical series stays in public.*). */
export const oraclePricePublished = onchainTable(
  "oracle_price_published",
  (t) => ({
    ...eventColumns(),
    gpuId: t.hex().notNull(),
    price: t.bigint().notNull(),
    previousPrice: t.bigint().notNull(),
    updatedAtSec: t.int8("updated_at_sec", { mode: "number" }).notNull(),
  }),
  (table) => ({
    pk: eventPk(table),
    oracle_price_published_gpu_idx: index("oracle_price_published_gpu_idx").on(
      table.chainId,
      table.gpuId,
      table.blockNumber,
    ),
  }),
);

/** GPUPriceOracle.PriceOverridden — owner hatch (deploy seed, incident path). */
export const oraclePriceOverridden = onchainTable(
  "oracle_price_overridden",
  (t) => ({
    ...eventColumns(),
    gpuId: t.hex().notNull(),
    price: t.bigint().notNull(),
    updatedAtSec: t.int8("updated_at_sec", { mode: "number" }).notNull(),
  }),
  (table) => ({
    pk: eventPk(table),
    oracle_price_overridden_gpu_idx: index(
      "oracle_price_overridden_gpu_idx",
    ).on(table.chainId, table.gpuId, table.blockNumber),
  }),
);

/** GPUPriceOracle.PublisherAccepted — publisher identity history. */
export const oraclePublisherAccepted = onchainTable(
  "oracle_publisher_accepted",
  (t) => ({
    ...eventColumns(),
    previousPublisher: t.hex().notNull(),
    newPublisher: t.hex().notNull(),
  }),
  (table) => ({ pk: eventPk(table) }),
);

/** PoolManager.Initialize — execution-state birth of a canonical pool. */
export const pmPoolInitialized = onchainTable(
  "pm_pool_initialized",
  (t) => ({
    ...eventColumns(),
    poolId: t.hex().notNull(),
    currency0: t.hex().notNull(),
    currency1: t.hex().notNull(),
    fee: t.integer().notNull(),
    tickSpacing: t.integer().notNull(),
    hooks: t.hex().notNull(),
    sqrtPriceX96: t.bigint().notNull(),
    tick: t.integer().notNull(),
  }),
  (table) => ({ pk: eventPk(table) }),
);

/** PoolManager.Swap — the AMM primitive tape. amount0/amount1 are the pool's
 *  fee-adjusted deltas (hook fee excluded); sender is the calling locker. */
export const pmSwap = onchainTable(
  "pm_swap",
  (t) => ({
    ...eventColumns(),
    poolId: t.hex().notNull(),
    sender: t.hex().notNull(),
    amount0: t.bigint().notNull(),
    amount1: t.bigint().notNull(),
    sqrtPriceX96: t.bigint().notNull(),
    liquidity: t.bigint().notNull(),
    tick: t.integer().notNull(),
    fee: t.integer().notNull(),
  }),
  (table) => ({
    pk: eventPk(table),
    pm_swap_pool_idx: index("pm_swap_pool_idx").on(
      table.chainId,
      table.poolId,
      table.blockNumber,
    ),
  }),
);

/** PoolManager.ModifyLiquidity — AMM liquidity depth deltas. */
export const pmLiquidityModified = onchainTable(
  "pm_liquidity_modified",
  (t) => ({
    ...eventColumns(),
    poolId: t.hex().notNull(),
    sender: t.hex().notNull(),
    tickLower: t.integer().notNull(),
    tickUpper: t.integer().notNull(),
    liquidityDelta: t.bigint().notNull(),
    salt: t.hex().notNull(),
  }),
  (table) => ({
    pk: eventPk(table),
    pm_liquidity_modified_pool_idx: index("pm_liquidity_modified_pool_idx").on(
      table.chainId,
      table.poolId,
      table.blockNumber,
    ),
  }),
);

/** PoolManager.Donate. */
export const pmDonate = onchainTable(
  "pm_donate",
  (t) => ({
    ...eventColumns(),
    poolId: t.hex().notNull(),
    sender: t.hex().notNull(),
    amount0: t.bigint().notNull(),
    amount1: t.bigint().notNull(),
  }),
  (table) => ({ pk: eventPk(table) }),
);

/** PositionManager.ModifyPosition — mirrors PM.ModifyLiquidity with sender =
 *  the unlock locker (end user); the LP-attribution stamp. */
export const posmPositionModified = onchainTable(
  "posm_position_modified",
  (t) => ({
    ...eventColumns(),
    poolId: t.hex().notNull(),
    sender: t.hex().notNull(),
    tickLower: t.integer().notNull(),
    tickUpper: t.integer().notNull(),
    liquidityDelta: t.bigint().notNull(),
    salt: t.hex().notNull(),
  }),
  (table) => ({
    pk: eventPk(table),
    posm_position_modified_pool_idx: index(
      "posm_position_modified_pool_idx",
    ).on(table.chainId, table.poolId, table.blockNumber),
  }),
);

/** PositionManager ERC-721 Transfer — LP position-token ownership history
 *  (per-tokenId attribution is deferred future work; captured now). Every
 *  minted position token is amount 1 by construction, so there is no amount
 *  column. */
export const posmTransfer = onchainTable(
  "posm_transfer",
  (t) => ({
    ...eventColumns(),
    tokenId: t.bigint().notNull(),
    from: t.hex().notNull(),
    to: t.hex().notNull(),
  }),
  (table) => ({ pk: eventPk(table) }),
);

/** ERC-20 Transfer for gUSD / sgUSD / GPUToken — the balance projector.
 *  Internal contract↔contract transfers create contract-addressed rows:
 *  authoritative for balances, but never projected into user activity. */
export const tokenTransfer = onchainTable(
  "token_transfer",
  (t) => ({
    ...eventColumns(),
    token: t.hex().notNull(),
    from: t.hex().notNull(),
    to: t.hex().notNull(),
    value: t.bigint().notNull(),
  }),
  (table) => ({
    pk: eventPk(table),
    token_transfer_token_from_idx: index("token_transfer_token_from_idx").on(
      table.chainId,
      table.token,
      table.from,
      table.blockNumber,
    ),
    token_transfer_token_to_idx: index("token_transfer_token_to_idx").on(
      table.chainId,
      table.token,
      table.to,
      table.blockNumber,
    ),
  }),
);

// ---------------------------------------------------------------------------
// Derived/current-state tables — upserted; delta-based counters converge
// under Ponder's reorg rollback + handler replay
// ---------------------------------------------------------------------------

/** Per-pool state + cumulatives. `ammPriceGusd` is derived at the API from
 *  sqrtPriceX96 — AMM EXECUTION STATE, never a market/reference price. */
export const pools = onchainTable(
  "pools",
  (t) => ({
    chainId: t.integer("chain_id").notNull(),
    poolId: t.hex("pool_id").notNull(),
    gpuId: t.hex("gpu_id"),
    /** Canonical per GPUHook.PoolRegistered — the persisted guard. */
    canonical: t.boolean().notNull(),
    registeredBlockNumber: t.integer("registered_block_number"),
    registeredAtSec: t.int8("registered_at_sec", { mode: "number" }),
    // pool key + execution state (filled from PoolManager.Initialize)
    currency0: t.hex("currency0"),
    currency1: t.hex("currency1"),
    fee: t.integer("fee"),
    tickSpacing: t.integer("tick_spacing"),
    hooks: t.hex("hooks"),
    gusdIsCurrency0: t.boolean("gusd_is_currency0"),
    sqrtPriceX96: t.bigint("sqrt_price_x96"),
    tick: t.integer("tick"),
    liquidity: t.bigint("liquidity"),
    // cumulatives (gUSD raw 6-dec). Volume = swapper gUSD moved through the
    // native leg (pm_swap deltas) + hook-fill gUSD (GpuFill.gusdAmount,
    // gross of the fill's protocol fee); hookFeesGusd = Σ GpuFill.protocolFee.
    swapCount: t.int8("swap_count", { mode: "number" }).notNull(),
    volumeGusd: t.bigint("volume_gusd").notNull(),
    buyVolumeGusd: t.bigint("buy_volume_gusd").notNull(),
    sellVolumeGusd: t.bigint("sell_volume_gusd").notNull(),
    hookFeesGusd: t.bigint("hook_fees_gusd").notNull(),
    lpFeesGusdEst: t.bigint("lp_fees_gusd_est").notNull(),
    lastSwapAtSec: t.int8("last_swap_at_sec", { mode: "number" }),
    lastSwapBlockNumber: t.integer("last_swap_block_number"),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.poolId] }),
    pools_gpu_idx: index("pools_gpu_idx").on(table.chainId, table.gpuId),
  }),
);

/** Per-GPU asset stats (catalog metadata joined at the API). */
export const gpuAssets = onchainTable(
  "gpu_assets",
  (t) => ({
    chainId: t.integer("chain_id").notNull(),
    gpuId: t.hex("gpu_id").notNull(),
    token: t.hex("token").notNull(),
    gpuSku: t.text("gpu_sku").notNull(),
    issuanceFeeBps: t.integer("issuance_fee_bps").notNull(),
    issuanceEnabled: t.boolean("issuance_enabled").notNull(),
    poolFee: t.integer("pool_fee").notNull(),
    tickSpacing: t.integer("tick_spacing").notNull(),
    canonicalPoolId: t.hex("canonical_pool_id"),
    // primary market
    issuedGpu: t.bigint("issued_gpu").notNull(),
    issuedCount: t.int8("issued_count", { mode: "number" }).notNull(),
    issuanceProceedsGusd: t.bigint("issuance_proceeds_gusd").notNull(),
    issuanceFeesGusd: t.bigint("issuance_fees_gusd").notNull(),
    // Cumulative primary principal capitalized into the market-making vault
    // — an accounting STATISTIC, never a claim on present assets; once
    // converted to GPU by trades it no longer corresponds to held gUSD.
    principalContributedGusd: t.bigint("principal_contributed_gusd").notNull(),
    // Protocol-owned market-making inventory (GPUMarketLiquidity vault),
    // delta-tracked from the vault's GpuNoted/BidCredited/InventoryPulled
    // events: polGusd = bid-side gUSD buying the next sell, polGpu = ask-side
    // GPU inventory selling into the next buy. Executable sell depth is
    // polGusd priced at the bid edge — honestly finite, per market.
    polGusd: t.bigint("pol_gusd").notNull(),
    polGpu: t.bigint("pol_gpu").notNull(),
    // Σ GpuFill.protocolFee on this market (POL + issuance-backstop fees).
    polFeesGusd: t.bigint("pol_fees_gusd").notNull(),
    firstIssuedAtSec: t.int8("first_issued_at_sec", { mode: "number" }),
    lastIssuedAtSec: t.int8("last_issued_at_sec", { mode: "number" }),
    // secondary market (routed executions)
    buyCount: t.int8("buy_count", { mode: "number" }).notNull(),
    sellCount: t.int8("sell_count", { mode: "number" }).notNull(),
    volumeGusd: t.bigint("volume_gusd").notNull(),
    lastTradeAtSec: t.int8("last_trade_at_sec", { mode: "number" }),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.chainId, table.gpuId] }) }),
);

/** Indexed oracle state — transparency/health/comparison only. */
export const oracleState = onchainTable(
  "oracle_state",
  (t) => ({
    chainId: t.integer("chain_id").notNull(),
    gpuId: t.hex("gpu_id").notNull(),
    price: t.bigint("price"),
    previousPrice: t.bigint("previous_price"),
    updatedAtSec: t.int8("updated_at_sec", { mode: "number" }),
    overriddenPrice: t.bigint("overridden_price"),
    overriddenAtSec: t.int8("overridden_at_sec", { mode: "number" }),
    lastPublishedBlockNumber: t.integer("last_published_block_number"),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.chainId, table.gpuId] }) }),
);

/** Authoritative token balances from raw Transfers. Contract-addressed rows
 *  exist (internal transfers) and are filtered at the API. */
/** GPUToken address → gpuId (PK lookup for the transfer-demotion path —
 *  gpu_assets is keyed by gpuId, so token→gpuId needs its own key). */
export const gpuTokens = onchainTable(
  "gpu_tokens",
  (t) => ({
    chainId: t.integer("chain_id").notNull(),
    token: t.hex("token").notNull(),
    gpuId: t.hex("gpu_id").notNull(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.chainId, table.token] }) }),
);

export const walletBalances = onchainTable(
  "wallet_balances",
  (t) => ({
    chainId: t.integer("chain_id").notNull(),
    wallet: t.hex("wallet").notNull(),
    token: t.hex("token").notNull(),
    balance: t.bigint("balance").notNull(),
    transferCount: t.int8("transfer_count", { mode: "number" }).notNull(),
    lastTransferAtSec: t.int8("last_transfer_at_sec", { mode: "number" }),
    lastTransferBlockNumber: t.integer("last_transfer_block_number"),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.wallet, table.token] }),
    wallet_balances_wallet_idx: index("wallet_balances_wallet_idx").on(
      table.chainId,
      table.wallet,
    ),
  }),
);

/** Protocol-attributable WAC cost basis per GPU token — separate from
 *  balances by design (rev 2). Acquisitions: Issued (base+fee) + Buy (paid);
 *  disposals: Sell (out treated gUSD-equivalent). Raw transfers never move
 *  basis — they demote basisState. qty/cost/realized are raw units
 *  (GPU 18-dec, gUSD 6-dec, floor-rounded deterministic integer math);
 *  avgEntry derives at the API as cost/qty (never stored fractionally). */
export const walletCostBasis = onchainTable(
  "wallet_cost_basis",
  (t) => ({
    chainId: t.integer("chain_id").notNull(),
    wallet: t.hex("wallet").notNull(),
    gpuId: t.hex("gpu_id").notNull(),
    qtyGpu: t.bigint("qty_gpu").notNull(),
    costGusd: t.bigint("cost_gusd").notNull(),
    realizedPnlGusd: t.bigint("realized_pnl_gusd").notNull(),
    basisState: basisState("basis_state").notNull(),
    acquisitions: t.int8("acquisitions", { mode: "number" }).notNull(),
    disposals: t.int8("disposals", { mode: "number" }).notNull(),
    firstActivityAtSec: t.int8("first_activity_at_sec", { mode: "number" }),
    lastActivityAtSec: t.int8("last_activity_at_sec", { mode: "number" }),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.wallet, table.gpuId] }),
    wallet_cost_basis_wallet_idx: index("wallet_cost_basis_wallet_idx").on(
      table.chainId,
      table.wallet,
    ),
  }),
);

/** sGUSD stake position per wallet (shares 6-dec, assets gUSD 6-dec). */
export const walletVaultPositions = onchainTable(
  "wallet_vault_positions",
  (t) => ({
    chainId: t.integer("chain_id").notNull(),
    wallet: t.hex("wallet").notNull(),
    shares: t.bigint("shares").notNull(),
    assetsCost: t.bigint("assets_cost").notNull(),
    realizedPnlGusd: t.bigint("realized_pnl_gusd").notNull(),
    basisState: basisState("basis_state").notNull(),
    deposits: t.int8("deposits", { mode: "number" }).notNull(),
    withdraws: t.int8("withdraws", { mode: "number" }).notNull(),
    firstActivityAtSec: t.int8("first_activity_at_sec", { mode: "number" }),
    lastActivityAtSec: t.int8("last_activity_at_sec", { mode: "number" }),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.chainId, table.wallet] }) }),
);

/** Wallet registry — chain-derived only (1 user = 1 wallet is enforced at
 *  rest by user_wallets UNIQUE(address) in the web app, not here). */
export const wallets = onchainTable(
  "wallets",
  (t) => ({
    chainId: t.integer("chain_id").notNull(),
    address: t.hex("address").notNull(),
    firstSeenBlockNumber: t.integer("first_seen_block_number").notNull(),
    lastSeenBlockNumber: t.integer("last_seen_block_number").notNull(),
    eventCount: t.int8("event_count", { mode: "number" }).notNull(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.chainId, table.address] }) }),
);

/** Wallet-attributed evidence projection — the web wire contract's backing
 *  table. Closed set: Minted, Redeemed, Issued, Buy, Sell, Deposit, Withdraw
 *  (apps/web/src/domain/indexer.ts). data jsonb carries stringified bigints
 *  and lowercased addresses. No wall-clock column — seenAtMs maps at the API. */
export const userEvents = onchainTable(
  "user_events",
  (t) => ({
    ...eventColumns(),
    contract: t.hex().notNull(),
    event: t.text().notNull(),
    user: t.hex().notNull(),
    txHash: t.hex("tx_hash").notNull(),
    data: t.jsonb().notNull(),
  }),
  (table) => ({
    pk: eventPk(table),
    user_events_user_idx: index("user_events_user_idx").on(
      table.chainId,
      table.user,
      table.blockNumber,
      table.logIndex,
    ),
  }),
);

/** Hourly per-pool trade/fee buckets (gUSD raw). */
export const poolStatsHourly = onchainTable(
  "pool_stats_hourly",
  (t) => ({
    chainId: t.integer("chain_id").notNull(),
    poolId: t.hex("pool_id").notNull(),
    bucketStart: t.int8("bucket_start", { mode: "number" }).notNull(),
    volumeGusd: t.bigint("volume_gusd").notNull(),
    buyVolumeGusd: t.bigint("buy_volume_gusd").notNull(),
    sellVolumeGusd: t.bigint("sell_volume_gusd").notNull(),
    buys: t.int8("buys", { mode: "number" }).notNull(),
    sells: t.int8("sells", { mode: "number" }).notNull(),
    hookFeesGusd: t.bigint("hook_fees_gusd").notNull(),
    lpFeesGusdEst: t.bigint("lp_fees_gusd_est").notNull(),
    swaps: t.int8("swaps", { mode: "number" }).notNull(),
  }),
  (table) => ({
    pk: primaryKey({
      columns: [table.chainId, table.poolId, table.bucketStart],
    }),
  }),
);

/** LP book by (pool, tick range, salt) — liquidity net-adds from PM
 *  ModifyLiquidity, attribution stamps from POSM ModifyPosition. */
export const poolLiquidityPositions = onchainTable(
  "pool_liquidity_positions",
  (t) => ({
    chainId: t.integer("chain_id").notNull(),
    poolId: t.hex("pool_id").notNull(),
    tickLower: t.integer("tick_lower").notNull(),
    tickUpper: t.integer("tick_upper").notNull(),
    salt: t.hex("salt").notNull(),
    liquidity: t.bigint("liquidity").notNull(),
    firstModifier: t.hex("first_modifier").notNull(),
    lastModifier: t.hex("last_modifier").notNull(),
    modifyCount: t.int8("modify_count", { mode: "number" }).notNull(),
    firstModifiedAtSec: t.int8("first_modified_at_sec", { mode: "number" }),
    lastModifiedAtSec: t.int8("last_modified_at_sec", { mode: "number" }),
  }),
  (table) => ({
    pk: primaryKey({
      columns: [
        table.chainId,
        table.poolId,
        table.tickLower,
        table.tickUpper,
        table.salt,
      ],
    }),
  }),
);

/** Protocol singleton stats + config mirrors. Created lazily per chain on
 *  the first relevant event; every counter is delta-based. */
export const protocolStats = onchainTable(
  "protocol_stats",
  (t) => ({
    chainId: t.integer("chain_id").notNull(),
    // gUSD supply side
    gusdMintedGusd: t.bigint("gusd_minted_gusd").notNull(),
    gusdRedeemedGusd: t.bigint("gusd_redeemed_gusd").notNull(),
    mintCount: t.int8("mint_count", { mode: "number" }).notNull(),
    redeemCount: t.int8("redeem_count", { mode: "number" }).notNull(),
    // primary market
    issuedGpu: t.bigint("issued_gpu").notNull(),
    issuedCount: t.int8("issued_count", { mode: "number" }).notNull(),
    issuanceProceedsGusd: t.bigint("issuance_proceeds_gusd").notNull(),
    issuanceFeesGusd: t.bigint("issuance_fees_gusd").notNull(),
    // secondary market (routed executions)
    buyCount: t.int8("buy_count", { mode: "number" }).notNull(),
    sellCount: t.int8("sell_count", { mode: "number" }).notNull(),
    buyVolumeGusd: t.bigint("buy_volume_gusd").notNull(),
    sellVolumeGusd: t.bigint("sell_volume_gusd").notNull(),
    // fees + revenue
    hookFeesGusd: t.bigint("hook_fees_gusd").notNull(),
    lpFeesGusdEst: t.bigint("lp_fees_gusd_est").notNull(),
    revenueDistributedGusd: t.bigint("revenue_distributed_gusd").notNull(),
    revenueToVaultGusd: t.bigint("revenue_to_vault_gusd").notNull(),
    revenueToTreasuryGusd: t.bigint("revenue_to_treasury_gusd").notNull(),
    // config mirrors (last-write-wins by event order)
    mintFeeBps: t.integer("mint_fee_bps"),
    redeemFeeBps: t.integer("redeem_fee_bps"),
    hookFeeBps: t.integer("hook_fee_bps"),
    maxOracleStalenessSec: t.int8("max_oracle_staleness_sec", {
      mode: "number",
    }),
    maxDeviationBps: t.integer("max_deviation_bps"),
    sgusdSplitBps: t.integer("sgusd_split_bps"),
    vault: t.hex("vault"),
    treasury: t.hex("treasury"),
    // The oracle publisher is per-oracle (global), not per-GPU — mirrored
    // from GPUPriceOracle.PublisherAccepted; the INITIAL publisher never
    // emits an event (it is known from the deployment JSON instead).
    publisher: t.hex("publisher"),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.chainId] }) }),
);

/** sgUSD vault aggregates (share price derives at the API). */
export const sgusdVault = onchainTable(
  "sgusd_vault",
  (t) => ({
    chainId: t.integer("chain_id").notNull(),
    seededGusd: t.bigint("seeded_gusd").notNull(),
    depositsGusd: t.bigint("deposits_gusd").notNull(),
    withdrawsGusd: t.bigint("withdraws_gusd").notNull(),
    sharesMinted: t.bigint("shares_minted").notNull(),
    sharesBurned: t.bigint("shares_burned").notNull(),
    depositCount: t.int8("deposit_count", { mode: "number" }).notNull(),
    withdrawCount: t.int8("withdraw_count", { mode: "number" }).notNull(),
    revenueGusd: t.bigint("revenue_gusd").notNull(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.chainId] }) }),
);

/** Day-grain protocol series for charts. */
export const protocolStatsDaily = onchainTable(
  "protocol_stats_daily",
  (t) => ({
    chainId: t.integer("chain_id").notNull(),
    bucketStart: t.int8("bucket_start", { mode: "number" }).notNull(),
    mintedGusd: t.bigint("minted_gusd").notNull(),
    redeemedGusd: t.bigint("redeemed_gusd").notNull(),
    mintCount: t.int8("mint_count", { mode: "number" }).notNull(),
    redeemCount: t.int8("redeem_count", { mode: "number" }).notNull(),
    issuedGpu: t.bigint("issued_gpu").notNull(),
    issuedCount: t.int8("issued_count", { mode: "number" }).notNull(),
    issuanceProceedsGusd: t.bigint("issuance_proceeds_gusd").notNull(),
    buyVolumeGusd: t.bigint("buy_volume_gusd").notNull(),
    sellVolumeGusd: t.bigint("sell_volume_gusd").notNull(),
    buyCount: t.int8("buy_count", { mode: "number" }).notNull(),
    sellCount: t.int8("sell_count", { mode: "number" }).notNull(),
    hookFeesGusd: t.bigint("hook_fees_gusd").notNull(),
    revenueDistributedGusd: t.bigint("revenue_distributed_gusd").notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.bucketStart] }),
  }),
);
