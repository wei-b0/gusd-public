/**
 * GPUHook handlers. PoolRegistered (emitted in afterInitialize, before any
 * trading) is the AUTHORITATIVE canonicality signal (rev 2): it upserts the
 * persisted `pools.canonical` flag that PoolManager/PositionManager handlers
 * re-check through context.db, and links the GPU asset to its canonical pool.
 *
 * A registration whose pool id never appeared through the (source-filtered)
 * PoolManager leaves `pools.currency0` NULL — the ops signal for "canonical
 * pool outside the static filter" (gotcha #11): detectable by SQL
 * (canonical = true AND currency0 IS NULL), runbook = redeploy the indexer
 * with recomputed pool ids. No in-memory state here, ever.
 */
import { ponder } from "ponder:registry";
import {
  gpuAssets,
  hookFeeAccrued,
  hookPoolRegistered,
  hookFeesHarvested,
  pools,
  protocolStats,
} from "ponder:schema";
import { eventKeys } from "../events.js";
import { bumpDailyBucket, bumpPoolHourBucket } from "./buckets.js";
import { zeroProtocolStats } from "./stats.js";

ponder.on("GPUHook:PoolRegistered", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { gpuId, poolId } = event.args;
  const chainId = context.chain.id;
  const registeredAtSec = Number(event.block.timestamp);
  const registeredBlockNumber = Number(event.block.number);

  await context.db
    .insert(hookPoolRegistered)
    .values({ ...keys, poolId, gpuId });

  // The pool row may or may not exist yet: PoolManager.Initialize normally
  // precedes (same tx), but on a pool outside the filter it never arrives —
  // the row is still created so the gap stays visible in SQL.
  await context.db
    .insert(pools)
    .values({
      chainId,
      poolId,
      gpuId,
      canonical: true,
      registeredBlockNumber,
      registeredAtSec,
      swapCount: 0,
      volumeGusd: 0n,
      buyVolumeGusd: 0n,
      sellVolumeGusd: 0n,
      hookFeesGusd: 0n,
      lpFeesGusdEst: 0n,
      harvestedFeesGusd: 0n,
    })
    .onConflictDoUpdate({
      gpuId,
      canonical: true,
      registeredBlockNumber,
      registeredAtSec,
    });

  // GpuCreated always precedes pool initialization (the pool key needs the
  // token), so the asset row exists — a missing row is a loud failure, not a
  // silent no-op.
  const asset = await context.db.find(gpuAssets, { chainId, gpuId });
  if (asset === null || asset === undefined) {
    throw new Error(
      `PoolRegistered for gpuId ${gpuId} before GpuCreated — indexing order violated`,
    );
  }
  await context.db
    .update(gpuAssets, { chainId, gpuId })
    .set({ canonicalPoolId: poolId });

  // Currency ordering: v4 sorts currencies by address, so currency0 is either
  // gUSD or the GPU token. The pool row (seeded by PoolManager.Initialize
  // earlier in the same tx) knows currency0; the asset row knows the token —
  // gusdIsCurrency0 = currency0 !== token. Swaps cannot precede registration,
  // so this is set before the first trade.
  const pool = await context.db.find(pools, { chainId, poolId });
  if (pool === null || pool === undefined) {
    // Outside the source filter: the row was just upserted above, so this is
    // unreachable — keep the guard loud anyway.
    throw new Error(
      `PoolRegistered for pool ${poolId} but no pools row exists`,
    );
  }
  if (pool.currency0 !== null && pool.currency0 !== undefined) {
    const gusdIsCurrency0 =
      pool.currency0.toLowerCase() !== asset.token.toLowerCase();
    await context.db
      .update(pools, { chainId, poolId })
      .set({ gusdIsCurrency0 });
  }
});

ponder.on("GPUHook:TradingFeeAccrued", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { poolId, gpuId, isBuy, gusdFee } = event.args;

  await context.db
    .insert(hookFeeAccrued)
    .values({ ...keys, poolId, gpuId, isBuy, gusdFee });

  // The hook fee is funded by the swapper's gUSD input (v4 Swap deltas are
  // the swapper's delta), so raw swap-delta volume includes it. The plan pins
  // pool volume as fee-free: this event is the ONLY exact hook-fee source,
  // and in log order it always follows its Swap within the same tx — so the
  // netting here converges (delta-based, reorg-safe). Direction comes from
  // the pool's lastSwapIsBuy (derived from the swapper delta by the Swap
  // handler): the event's own isBuy flag carries the hook's `exactIn`, which
  // is not the economic direction. Never net hook fees into lpFeesGusdEst.
  const pool = await context.db.find(pools, { chainId: keys.chainId, poolId });
  if (pool === null || pool === undefined) {
    throw new Error(`TradingFeeAccrued for untracked pool ${poolId}`);
  }
  if (pool.lastSwapIsBuy === null || pool.lastSwapIsBuy === undefined) {
    throw new Error(
      `TradingFeeAccrued for pool ${poolId} with no preceding Swap — order invariant broken`,
    );
  }
  const buySide = pool.lastSwapIsBuy;
  await context.db.update(pools, { chainId: keys.chainId, poolId }).set({
    hookFeesGusd: pool.hookFeesGusd + gusdFee,
    volumeGusd: pool.volumeGusd - gusdFee,
    buyVolumeGusd: buySide ? pool.buyVolumeGusd - gusdFee : pool.buyVolumeGusd,
    sellVolumeGusd: buySide
      ? pool.sellVolumeGusd
      : pool.sellVolumeGusd - gusdFee,
  });

  // Net the fee out of the same hour bucket its Swap filled (same tx → same
  // block timestamp → same bucket) — pool volume stays fee-free in buckets
  // exactly as it does in the cumulatives. Negative deltas are the designed
  // mechanism here, not a hack.
  await bumpPoolHourBucket(
    context.db,
    keys.chainId,
    poolId,
    keys.blockTimestamp,
    {
      volumeGusd: -gusdFee,
      buyVolumeGusd: buySide ? -gusdFee : 0n,
      sellVolumeGusd: buySide ? 0n : -gusdFee,
      hookFeesGusd: gusdFee,
    },
  );

  await context.db
    .insert(protocolStats)
    .values(zeroProtocolStats(keys.chainId))
    .onConflictDoUpdate((row) => ({
      hookFeesGusd: row.hookFeesGusd + gusdFee,
    }));

  await bumpDailyBucket(context.db, keys.chainId, keys.blockTimestamp, {
    hookFeesGusd: gusdFee,
  });
});

ponder.on("GPUHook:TradingFeesHarvested", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { poolId, amount } = event.args;

  await context.db
    .insert(hookFeesHarvested)
    .values({ ...keys, poolId, amount });

  const pool = await context.db.find(pools, { chainId: keys.chainId, poolId });
  if (pool === null || pool === undefined) {
    throw new Error(`TradingFeesHarvested for untracked pool ${poolId}`);
  }
  await context.db
    .update(pools, { chainId: keys.chainId, poolId })
    .set({ harvestedFeesGusd: pool.harvestedFeesGusd + amount });

  await context.db
    .insert(protocolStats)
    .values(zeroProtocolStats(keys.chainId))
    .onConflictDoUpdate((row) => ({
      harvestedFeesGusd: row.harvestedFeesGusd + amount,
    }));
});

ponder.on("GPUHook:HookFeeBpsSet", async ({ event, context }) => {
  const { newFeeBps } = event.args;
  await context.db
    .insert(protocolStats)
    .values({ ...zeroProtocolStats(context.chain.id), hookFeeBps: newFeeBps })
    .onConflictDoUpdate({ hookFeeBps: newFeeBps });
});
