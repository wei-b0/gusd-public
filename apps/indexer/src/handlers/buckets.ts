/**
 * Net-add bucket upserts — the DB legs of the time-series aggregates
 * (protocol_stats_daily, pool_stats_hourly). Every write inserts the zero
 * row + delta and adds the same delta on conflict — delta-based, so reorg
 * rollback + replay converges (same contract as the singleton stats).
 * Bucket starts derive from the event's block timestamp via
 * projections/buckets (chain time only).
 *
 * The structural Db view mirrors wallet-state.ts: Ponder's context.db is
 * declared by exactly the shape these helpers use.
 */
import type { Hex } from "viem";
import { poolStatsHourly, protocolStatsDaily } from "ponder:schema";
import { dayBucketStart, hourBucketStart } from "../projections/buckets.js";

interface BucketDb {
  insert(table: typeof protocolStatsDaily): {
    values(value: typeof protocolStatsDaily.$inferInsert): {
      onConflictDoUpdate(
        fn: (
          row: typeof protocolStatsDaily.$inferSelect,
        ) => Partial<typeof protocolStatsDaily.$inferInsert>,
      ): Promise<unknown>;
    };
  };
  insert(table: typeof poolStatsHourly): {
    values(value: typeof poolStatsHourly.$inferInsert): {
      onConflictDoUpdate(
        fn: (
          row: typeof poolStatsHourly.$inferSelect,
        ) => Partial<typeof poolStatsHourly.$inferInsert>,
      ): Promise<unknown>;
    };
  };
}

type DailyDelta = Partial<
  Omit<typeof protocolStatsDaily.$inferInsert, "chainId" | "bucketStart">
>;
type PoolHourDelta = Partial<
  Omit<
    typeof poolStatsHourly.$inferInsert,
    "chainId" | "poolId" | "bucketStart"
  >
>;

function zeroDailyBucket(
  chainId: number,
  bucketStart: number,
): typeof protocolStatsDaily.$inferInsert {
  return {
    chainId,
    bucketStart,
    mintedGusd: 0n,
    redeemedGusd: 0n,
    mintCount: 0,
    redeemCount: 0,
    issuedGpu: 0n,
    issuedCount: 0,
    issuanceProceedsGusd: 0n,
    buyVolumeGusd: 0n,
    sellVolumeGusd: 0n,
    buyCount: 0,
    sellCount: 0,
    hookFeesGusd: 0n,
    revenueDistributedGusd: 0n,
  };
}

function zeroPoolHourBucket(
  chainId: number,
  poolId: Hex,
  bucketStart: number,
): typeof poolStatsHourly.$inferInsert {
  return {
    chainId,
    poolId,
    bucketStart,
    volumeGusd: 0n,
    buyVolumeGusd: 0n,
    sellVolumeGusd: 0n,
    buys: 0,
    sells: 0,
    hookFeesGusd: 0n,
    lpFeesGusdEst: 0n,
    swaps: 0,
  };
}

/** Add a day-grain protocol delta for the bucket containing timestampSec
 *  (chain time). Negative deltas are legal — the hook-fee netting uses
 *  them on the pool buckets, and the same door stays open here. */
export async function bumpDailyBucket(
  db: BucketDb,
  chainId: number,
  timestampSec: number,
  delta: DailyDelta,
): Promise<void> {
  const bucketStart = Number(dayBucketStart(BigInt(timestampSec)));
  await db
    .insert(protocolStatsDaily)
    .values({ ...zeroDailyBucket(chainId, bucketStart), ...delta })
    .onConflictDoUpdate((row) => ({
      mintedGusd: row.mintedGusd + (delta.mintedGusd ?? 0n),
      redeemedGusd: row.redeemedGusd + (delta.redeemedGusd ?? 0n),
      mintCount: row.mintCount + (delta.mintCount ?? 0),
      redeemCount: row.redeemCount + (delta.redeemCount ?? 0),
      issuedGpu: row.issuedGpu + (delta.issuedGpu ?? 0n),
      issuedCount: row.issuedCount + (delta.issuedCount ?? 0),
      issuanceProceedsGusd:
        row.issuanceProceedsGusd + (delta.issuanceProceedsGusd ?? 0n),
      buyVolumeGusd: row.buyVolumeGusd + (delta.buyVolumeGusd ?? 0n),
      sellVolumeGusd: row.sellVolumeGusd + (delta.sellVolumeGusd ?? 0n),
      buyCount: row.buyCount + (delta.buyCount ?? 0),
      sellCount: row.sellCount + (delta.sellCount ?? 0),
      hookFeesGusd: row.hookFeesGusd + (delta.hookFeesGusd ?? 0n),
      revenueDistributedGusd:
        row.revenueDistributedGusd + (delta.revenueDistributedGusd ?? 0n),
    }));
}

/** Add an hourly per-pool delta for the bucket containing timestampSec
 *  (chain time). The TradingFeeAccrued handler nets the hook fee out of the
 *  same bucket its Swap filled (same tx → same block timestamp → same
 *  bucket), so bucket sums reconcile with the fee-netted pool cumulatives. */
export async function bumpPoolHourBucket(
  db: BucketDb,
  chainId: number,
  poolId: Hex,
  timestampSec: number,
  delta: PoolHourDelta,
): Promise<void> {
  const bucketStart = Number(hourBucketStart(BigInt(timestampSec)));
  await db
    .insert(poolStatsHourly)
    .values({ ...zeroPoolHourBucket(chainId, poolId, bucketStart), ...delta })
    .onConflictDoUpdate((row) => ({
      volumeGusd: row.volumeGusd + (delta.volumeGusd ?? 0n),
      buyVolumeGusd: row.buyVolumeGusd + (delta.buyVolumeGusd ?? 0n),
      sellVolumeGusd: row.sellVolumeGusd + (delta.sellVolumeGusd ?? 0n),
      buys: row.buys + (delta.buys ?? 0),
      sells: row.sells + (delta.sells ?? 0),
      hookFeesGusd: row.hookFeesGusd + (delta.hookFeesGusd ?? 0n),
      lpFeesGusdEst: row.lpFeesGusdEst + (delta.lpFeesGusdEst ?? 0n),
      swaps: row.swaps + (delta.swaps ?? 0),
    }));
}
