/**
 * GpuPerpEngine handlers — the perpetual futures book. Two layers per event:
 * an append-only log row (evidence), and the derived state the keeper and the
 * web read (PerpMarket / PerpPosition / PerpOrder / PerpClaimable /
 * PerpEngineStats).
 *
 * Determinism notes that keep the offline math honest:
 *  - PositionIncreased/Decreased carry the ABSOLUTE post-touch state AND the
 *    post-touch funding checkpoints (the engine emits them for exactly this
 *    consumer) — handlers overwrite with event values, never re-derive from
 *    market cumulatives. The clamp-rewind case (uncollected funding debt kept
 *    in the checkpoint) is therefore encoded exactly.
 *  - Claimable balances accrue from exactly the deltas the engine's
 *    claimableOf grows/shrinks by: OrderExecuted.claimableDelta (market
 *    decreases, trigger fills, AND increase-time funding credits — the engine
 *    emits the earned credit there) plus ClaimableSettled (liquidations),
 *    minus Claimed.paid. PositionLiquidated.claimableDelta is deliberately
 *    NOT accumulated — ClaimableSettled fires in the same transaction.
 *  - realizedPnl accrues to PerpPosition.realizedPnlGusd from
 *    OrderExecuted.realizedPnl on decrease-shaped executions ONLY — both
 *    PositionDecreased and PositionLiquidated also carry the figure, and
 *    folding those in would double count.
 *  - Positions are never deleted (Envio has no delete): a closed or
 *    liquidated row keeps its last state with sizeUsd = 0 and a
 *    closedAtSec/liquidatedAtSec stamp. The keeper filters on sizeUsd > 0.
 *
 * Money columns stay native BigInt through the read-back (kept OUT of the
 * tables' bigintNumbers lists) so the delta math is exact; counts/timestamps
 * use the bigintNumbers Number round-trip like every other table.
 *
 * Funding accrual ordering: PerpFunding.accrue (inside executeOrder and
 * liquidate) emits FundingAccrued BEFORE the touch's position events, and
 * handlers run in log order, so the PerpMarket row is current for every
 * position write in the same transaction.
 */
import { handlers } from "../envio-compat.js";
import {
  perpClaimable,
  perpClaimableSettled,
  perpClaimed,
  perpEngineStats,
  perpFundingAccrued,
  perpMarkets,
  perpOrderCancelled,
  perpOrderCreated,
  perpOrderExecuted,
  perpOrders,
  perpPositionClosed,
  perpPositionDecreased,
  perpPositionIncreased,
  perpPositionLiquidated,
  perpPositions,
  sgusdEngineWithdrawal,
} from "../schema.js";
import { eventKeys, eventTxHash } from "../events.js";
import { recordUserEvent } from "./user-event.js";

type Db = Record<string, any>;
type Keys = { chainId: number; blockTimestamp: number };

const ZERO = 0n;
const KIND_MARKET_INCREASE = 0;

function lowerAddr(v: unknown): string {
  return String(v).toLowerCase();
}


// ------------------------------------------------------------- market config

handlers.on("GpuPerpEngine:MarketCreated", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { gpuId, params } = event.args;
  await context.db.insert(perpMarkets).values({
    chainId: keys.chainId,
    gpuId: String(gpuId),
    enabled: true,
    maxLeverageBps: params.maxLeverageBps,
    maintenanceMarginBps: params.maintenanceMarginBps,
    openFeeBps: params.openFeeBps,
    closeFeeBps: params.closeFeeBps,
    liquidationFeeBps: params.liquidationFeeBps,
    fundingRatePpmPerSec: params.fundingRatePpmPerSec,
    borrowRatePpmPerSec: params.borrowRatePpmPerSec,
    maxOiUsd: params.maxOiUsd,
    minCollateralUsd: params.minCollateralUsd,
    maxPositionUsd: params.maxPositionUsd,
    openNotionalLong: ZERO,
    openNotionalShort: ZERO,
    fundingChargePerUnitLong: ZERO,
    fundingChargePerUnitShort: ZERO,
    fundingCreditPerUnitLong: ZERO,
    fundingCreditPerUnitShort: ZERO,
    borrowChargePerUnit: ZERO,
    fundingUpdatedAtSec: keys.blockTimestamp,
    createdAtSec: keys.blockTimestamp,
  });
});

handlers.on("GpuPerpEngine:MarketParamsUpdated", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { gpuId, params } = event.args;
  const id = String(gpuId);
  const existing = await context.db.find(perpMarkets, { chainId: keys.chainId, gpuId: id });
  if (!existing) return; // no market row without its create event
  await context.db.update(perpMarkets, { chainId: keys.chainId, gpuId: id }).set({
    maxLeverageBps: Number(params.maxLeverageBps),
    maintenanceMarginBps: Number(params.maintenanceMarginBps),
    openFeeBps: Number(params.openFeeBps),
    closeFeeBps: Number(params.closeFeeBps),
    liquidationFeeBps: Number(params.liquidationFeeBps),
    fundingRatePpmPerSec: Number(params.fundingRatePpmPerSec),
    borrowRatePpmPerSec: Number(params.borrowRatePpmPerSec),
    maxOiUsd: params.maxOiUsd,
    minCollateralUsd: params.minCollateralUsd,
    maxPositionUsd: params.maxPositionUsd,
  });
});

handlers.on("GpuPerpEngine:MarketEnabled", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { gpuId, enabled } = event.args;
  const id = String(gpuId);
  const existing = await context.db.find(perpMarkets, { chainId: keys.chainId, gpuId: id });
  if (!existing) return;
  await context.db.update(perpMarkets, { chainId: keys.chainId, gpuId: id }).set({ enabled });
});

handlers.on("GpuPerpEngine:MinOrderDelaySet", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { seconds_ } = event.args;
  await context.db
    .insert(perpEngineStats)
    .values(zeroEngineStats(keys.chainId))
    .onConflictDoUpdate({ minOrderDelaySec: seconds_ });
});

// -------------------------------------------------------------------- orders

handlers.on("GpuPerpEngine:OrderCreated", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const a = event.args;
  const account = lowerAddr(a.account);
  await context.db.insert(perpOrderCreated).values({
    ...keys,
    orderId: a.orderId,
    account,
    gpuId: String(a.gpuId),
    kind: Number(a.kind),
    isLong: a.isLong,
    sizeDeltaUsd: a.sizeDeltaUsd,
    collateralDeltaUsd: a.collateralDeltaUsd,
    acceptablePrice: a.acceptablePrice,
    triggerPrice: a.triggerPrice,
    executionFee: a.executionFee,
  });
  await context.db.insert(perpOrders).values({
    chainId: keys.chainId,
    orderId: a.orderId,
    account,
    gpuId: String(a.gpuId),
    kind: Number(a.kind),
    status: 1, // Pending
    isLong: a.isLong,
    sizeDeltaUsd: a.sizeDeltaUsd,
    collateralDeltaUsd: a.collateralDeltaUsd,
    acceptablePrice: a.acceptablePrice,
    triggerPrice: a.triggerPrice,
    executionFee: a.executionFee,
    createdAtSec: keys.blockTimestamp,
  });
  await bumpEngineStats(context.db, keys, { orderCount: 1n });
  await recordUserEvent(context.db, {
    keys,
    contract: event.log.address,
    event: "PerpOrderCreated",
    user: a.account,
    args: a,
    txHash: eventTxHash(event),
  });
});

handlers.on("GpuPerpEngine:OrderExecuted", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const a = event.args;
  const account = lowerAddr(a.account);
  const kind = Number(a.kind);
  await context.db.insert(perpOrderExecuted).values({
    ...keys,
    orderId: a.orderId,
    executor: lowerAddr(a.executor),
    account,
    gpuId: String(a.gpuId),
    kind,
    isLong: a.isLong,
    execPrice: a.execPrice,
    executionFeePaid: a.executionFeePaid,
    sizeDeltaUsd: a.sizeDeltaUsd,
    realizedPnl: a.realizedPnl,
    feesPaid: a.feesPaid,
    fundingNet: a.fundingNet,
    claimableDelta: a.claimableDelta,
  });
  const orderRow = await context.db.find(perpOrders, {
    chainId: keys.chainId,
    orderId: a.orderId,
  });
  if (orderRow) {
    await context.db.update(perpOrders, { chainId: keys.chainId, orderId: a.orderId }).set({
      status: 2, // Executed
      resolvedAtSec: keys.blockTimestamp,
      executor: lowerAddr(a.executor),
      execPrice: a.execPrice,
      realizedPnl: a.realizedPnl,
      feesPaid: a.feesPaid,
      fundingNet: a.fundingNet,
      claimableDelta: a.claimableDelta,
    });
  }
  // Exactly one realized-pnl accrual per decrease-shaped touch lives here —
  // PositionDecreased/PositionLiquidated also carry the figure; folding those
  // in would double count.
  if (kind !== KIND_MARKET_INCREASE) {
    await creditPositionPnl(
      context.db,
      keys,
      account,
      String(a.gpuId),
      a.isLong,
      a.realizedPnl,
    );
  }
  // claimableOf grew by exactly this delta in the same tx (decrease `due`,
  // trigger `due`, or increase-time funding credit).
  if (a.claimableDelta > 0n) {
    await bumpClaimable(context.db, keys, account, {
      balance: a.claimableDelta,
      totalSettled: a.claimableDelta,
      settleCount: 1n,
    });
  }
  await recordUserEvent(context.db, {
    keys,
    contract: event.log.address,
    event: "PerpOrderExecuted",
    user: a.account,
    args: a,
    txHash: eventTxHash(event),
  });
});

handlers.on("GpuPerpEngine:OrderCancelled", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const a = event.args;
  await context.db.insert(perpOrderCancelled).values({
    ...keys,
    orderId: a.orderId,
    account: lowerAddr(a.account),
    kind: Number(a.kind),
    feeRefunded: a.feeRefunded,
    collateralRefunded: a.collateralRefunded,
  });
  await context.db.update(perpOrders, { chainId: keys.chainId, orderId: a.orderId }).set({
    status: 3, // Cancelled
    resolvedAtSec: keys.blockTimestamp,
  });
});

// ---------------------------------------------------------------- positions

handlers.on("GpuPerpEngine:PositionIncreased", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const a = event.args;
  const account = lowerAddr(a.account);
  const gpuId = String(a.gpuId);
  const existing = await context.db.find(perpPositions, {
    chainId: keys.chainId,
    wallet: account,
    gpuId,
    isLong: a.isLong,
  });
  const values = {
    chainId: keys.chainId,
    wallet: account,
    gpuId,
    isLong: a.isLong,
    sizeUsd: a.newSizeUsd,
    collateral: a.newCollateral,
    entryPrice: a.newEntryPrice,
    fundingFeeCheckpoint: a.fundingFeeCheckpoint,
    fundingCreditCheckpoint: a.fundingCreditCheckpoint,
    borrowCheckpoint: a.borrowCheckpoint,
    openedAtSec: keys.blockTimestamp,
    lastTouchedAtSec: keys.blockTimestamp,
    // Full zero defaults so a fresh insert never omits a non-null column
    // (same discipline as bumpClaimable) — a new position has never
    // decreased and realizes nothing yet.
    decreaseCount: ZERO,
    realizedPnlGusd: ZERO,
    increaseCount: (existing?.increaseCount ?? 0) + 1,
  };
  await context.db
    .insert(perpPositions)
    .values(values)
    .onConflictDoUpdate({
      sizeUsd: a.newSizeUsd,
      collateral: a.newCollateral,
      entryPrice: a.newEntryPrice,
      fundingFeeCheckpoint: a.fundingFeeCheckpoint,
      fundingCreditCheckpoint: a.fundingCreditCheckpoint,
      borrowCheckpoint: a.borrowCheckpoint,
      lastTouchedAtSec: keys.blockTimestamp,
      increaseCount: values.increaseCount,
    });
  await context.db.insert(perpPositionIncreased).values({
    ...keys,
    account,
    gpuId,
    isLong: a.isLong,
    newSizeUsd: a.newSizeUsd,
    newCollateral: a.newCollateral,
    newEntryPrice: a.newEntryPrice,
    fundingFeeCheckpoint: a.fundingFeeCheckpoint,
    fundingCreditCheckpoint: a.fundingCreditCheckpoint,
    borrowCheckpoint: a.borrowCheckpoint,
  });
});

handlers.on("GpuPerpEngine:PositionDecreased", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const a = event.args;
  const account = lowerAddr(a.account);
  const gpuId = String(a.gpuId);
  const existing = await context.db.find(perpPositions, {
    chainId: keys.chainId,
    wallet: account,
    gpuId,
    isLong: a.isLong,
  });
  const values = {
    chainId: keys.chainId,
    wallet: account,
    gpuId,
    isLong: a.isLong,
    sizeUsd: a.remainingSizeUsd,
    collateral: a.remainingCollateral,
    // The placeholder triple for the never-seen-before case (sync starting
    // after the open): entry unknown (ZERO — the creditPositionPnl fresh-row
    // convention), zero counts, zero realized pnl — the conflict branch on
    // an existing row overwrites only the event's own fields and never
    // touches entry/increaseCount.
    entryPrice: ZERO,
    fundingFeeCheckpoint: a.fundingFeeCheckpoint,
    fundingCreditCheckpoint: a.fundingCreditCheckpoint,
    borrowCheckpoint: a.borrowCheckpoint,
    lastTouchedAtSec: keys.blockTimestamp,
    increaseCount: ZERO,
    realizedPnlGusd: ZERO,
    decreaseCount: (existing?.decreaseCount ?? 0) + 1,
  };
  await context.db
    .insert(perpPositions)
    .values(values)
    .onConflictDoUpdate({
      sizeUsd: a.remainingSizeUsd,
      collateral: a.remainingCollateral,
      fundingFeeCheckpoint: a.fundingFeeCheckpoint,
      fundingCreditCheckpoint: a.fundingCreditCheckpoint,
      borrowCheckpoint: a.borrowCheckpoint,
      lastTouchedAtSec: keys.blockTimestamp,
      decreaseCount: values.decreaseCount,
    });
  await context.db.insert(perpPositionDecreased).values({
    ...keys,
    account,
    gpuId,
    isLong: a.isLong,
    sizeDeltaUsd: a.sizeDeltaUsd,
    realizedPnl: a.realizedPnl,
    fundingNet: a.fundingNet,
    closeFee: a.closeFee,
    claimableDelta: a.claimableDelta,
    remainingSizeUsd: a.remainingSizeUsd,
    remainingCollateral: a.remainingCollateral,
    fundingFeeCheckpoint: a.fundingFeeCheckpoint,
    fundingCreditCheckpoint: a.fundingCreditCheckpoint,
    borrowCheckpoint: a.borrowCheckpoint,
  });
});

handlers.on("GpuPerpEngine:PositionClosed", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const a = event.args;
  const account = lowerAddr(a.account);
  const gpuId = String(a.gpuId);
  const existing = await context.db.find(perpPositions, {
    chainId: keys.chainId,
    wallet: account,
    gpuId,
    isLong: a.isLong,
  });
  if (!existing) return;
  await context.db
    .update(perpPositions, {
      chainId: keys.chainId,
      wallet: account,
      gpuId,
      isLong: a.isLong,
    })
    .set({ sizeUsd: ZERO, closedAtSec: keys.blockTimestamp });
  await context.db.insert(perpPositionClosed).values({
    ...keys,
    account,
    gpuId,
    isLong: a.isLong,
    execPrice: a.execPrice,
  });
});

handlers.on("GpuPerpEngine:PositionLiquidated", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const a = event.args;
  const account = lowerAddr(a.account);
  const gpuId = String(a.gpuId);
  await context.db.insert(perpPositionLiquidated).values({
    ...keys,
    account,
    gpuId,
    isLong: a.isLong,
    executor: lowerAddr(a.executor),
    execPrice: a.execPrice,
    liquidationFee: a.liquidationFee,
    badDebt: a.badDebt,
    claimableDelta: a.claimableDelta,
  });
  const existing = await context.db.find(perpPositions, {
    chainId: keys.chainId,
    wallet: account,
    gpuId,
    isLong: a.isLong,
  });
  if (existing) {
    await context.db
      .update(perpPositions, {
        chainId: keys.chainId,
        wallet: account,
        gpuId,
        isLong: a.isLong,
      })
      .set({
        sizeUsd: ZERO,
        liquidatedAtSec: keys.blockTimestamp,
        liquidator: lowerAddr(a.executor),
      });
  }
  await bumpEngineStats(context.db, keys, { liquidationCount: 1n });
});

// ---------------------------------------------------------------- claimable

handlers.on("GpuPerpEngine:ClaimableSettled", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const a = event.args;
  const account = lowerAddr(a.account);
  await context.db.insert(perpClaimableSettled).values({
    ...keys,
    account,
    gpuId: String(a.gpuId),
    amount: a.amount,
  });
  if (a.amount > 0n) {
    await bumpClaimable(context.db, keys, account, {
      balance: a.amount,
      totalSettled: a.amount,
      settleCount: 1n,
    });
  }
});

handlers.on("GpuPerpEngine:Claimed", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const a = event.args;
  const account = lowerAddr(a.account);
  await context.db.insert(perpClaimed).values({
    ...keys,
    account,
    to: lowerAddr(a.to),
    requested: a.requested,
    paid: a.paid,
  });
  // The engine decrements claimableOf by what actually PAID — mirror that
  // (partial payments leave the remainder claimable, matching claimableOf).
  if (a.paid > 0n) {
    await bumpClaimable(context.db, keys, account, {
      // Unary minus on an `any` arg infers number — negate through BigInt().
      balance: -BigInt(a.paid),
      totalClaimed: a.paid,
      claimCount: 1n,
    });
  }
  await bumpEngineStats(context.db, keys, { claimedGusd: a.paid });
  await recordUserEvent(context.db, {
    keys,
    contract: event.log.address,
    event: "PerpClaimed",
    user: a.account,
    args: a,
    txHash: eventTxHash(event),
  });
});

// ------------------------------------------------------------------ funding

handlers.on("GpuPerpEngine:FundingAccrued", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const a = event.args;
  const gpuId = String(a.gpuId);
  await context.db.insert(perpFundingAccrued).values({
    ...keys,
    gpuId,
    chargePerUnitLong: a.chargePerUnitLong,
    chargePerUnitShort: a.chargePerUnitShort,
    creditPerUnitLong: a.creditPerUnitLong,
    creditPerUnitShort: a.creditPerUnitShort,
    borrowPerUnit: a.borrowPerUnit,
    updatedAtSec: a.updatedAt,
  });
  // MarketCreated precedes every accrual in log order, so this upsert only
  // refreshes cumulatives — the zero-params VALUES are a defensive fallback
  // for a market whose create event predates the sync start block.
  await context.db
    .insert(perpMarkets)
    .values({
      chainId: keys.chainId,
      gpuId,
      enabled: true,
      maxLeverageBps: 0,
      maintenanceMarginBps: 0,
      openFeeBps: 0,
      closeFeeBps: 0,
      liquidationFeeBps: 0,
      fundingRatePpmPerSec: 0,
      borrowRatePpmPerSec: 0,
      maxOiUsd: ZERO,
      minCollateralUsd: ZERO,
      maxPositionUsd: ZERO,
      openNotionalLong: ZERO,
      openNotionalShort: ZERO,
      fundingChargePerUnitLong: a.chargePerUnitLong,
      fundingChargePerUnitShort: a.chargePerUnitShort,
      fundingCreditPerUnitLong: a.creditPerUnitLong,
      fundingCreditPerUnitShort: a.creditPerUnitShort,
      borrowChargePerUnit: a.borrowPerUnit,
      fundingUpdatedAtSec: a.updatedAt,
      createdAtSec: keys.blockTimestamp,
    })
    .onConflictDoUpdate({
      fundingChargePerUnitLong: a.chargePerUnitLong,
      fundingChargePerUnitShort: a.chargePerUnitShort,
      fundingCreditPerUnitLong: a.creditPerUnitLong,
      fundingCreditPerUnitShort: a.creditPerUnitShort,
      borrowChargePerUnit: a.borrowPerUnit,
      fundingUpdatedAtSec: a.updatedAt,
    });
});

// --------------------------------------------------------------------- vault

handlers.on("SgUSD:EngineWithdrawal", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const a = event.args;
  await context.db.insert(sgusdEngineWithdrawal).values({
    ...keys,
    to: lowerAddr(a.to),
    requested: a.requested,
    paid: a.paid,
  });
});

// ------------------------------------------------------------------- helpers

function zeroEngineStats(chainId: number): Record<string, any> {
  return {
    chainId,
    minOrderDelaySec: null,
    orderCount: ZERO,
    liquidationCount: ZERO,
    settledGusd: ZERO,
    claimedGusd: ZERO,
  };
}

/** Delta-based upsert — the event's own delta rides the insert VALUES too
 *  (a row written verbatim when absent), then adds on conflict, so reorg
 *  rollback + replay converges (never SET x = total). Money fields are
 *  native BigInt on the read-back row (kept out of bigintNumbers). */
async function bumpEngineStats(
  db: Db,
  keys: Keys,
  deltas: Record<string, bigint>,
): Promise<void> {
  await db
    .insert(perpEngineStats)
    .values({ ...zeroEngineStats(keys.chainId), ...deltas })
    .onConflictDoUpdate((row: any) => {
      const patch: Record<string, any> = {};
      for (const [k, v] of Object.entries(deltas)) {
        patch[k] = BigInt(row[k] ?? 0n) + v;
      }
      return patch;
    });
}

async function bumpClaimable(
  db: Db,
  keys: Keys,
  wallet: string,
  deltas: { balance?: bigint; totalSettled?: bigint; totalClaimed?: bigint; settleCount?: bigint; claimCount?: bigint },
): Promise<void> {
  await db
    .insert(perpClaimable)
    .values({
      chainId: keys.chainId,
      wallet,
      // Full zero defaults so a fresh insert never omits a non-null column;
      // the deltas then ride the values exactly as the conflict branch adds them.
      balance: ZERO,
      totalSettled: ZERO,
      totalClaimed: ZERO,
      settleCount: ZERO,
      claimCount: ZERO,
      ...deltas,
    })
    .onConflictDoUpdate((row: any) => {
      const patch: Record<string, any> = { lastActivityAtSec: keys.blockTimestamp };
      for (const [k, v] of Object.entries(deltas)) {
        patch[k] = BigInt(row[k] ?? 0n) + v;
      }
      return patch;
    });
}

async function creditPositionPnl(
  db: Db,
  keys: Keys,
  account: string,
  gpuId: string,
  isLong: boolean,
  realizedPnl: bigint,
): Promise<void> {
  await db
    .insert(perpPositions)
    .values({
      chainId: keys.chainId,
      wallet: account,
      gpuId,
      isLong,
      sizeUsd: ZERO,
      collateral: ZERO,
      entryPrice: ZERO,
      openedAtSec: keys.blockTimestamp,
      lastTouchedAtSec: keys.blockTimestamp,
      realizedPnlGusd: realizedPnl,
    })
    .onConflictDoUpdate((row: any) => ({
      realizedPnlGusd: BigInt(row.realizedPnlGusd ?? 0n) + realizedPnl,
    }));
}