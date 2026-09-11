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
 *
 * C-max fill accounting: GpuFill carries the hook's fills per swap (one row
 * per fill source; `isBuy` IS the economic direction), and HookSwap carries
 * the URC-2 swapper-view deltas for lens/conformance consumers. Pool volume
 * = native-leg gUSD (the Swap handler) + Σ GpuFill.gusdAmount; hook fees =
 * Σ GpuFill.protocolFee — no cross-handler netting pass, ever.
 */
import { ponder } from "ponder:registry";
import {
  gpuAssets,
  gpuFill,
  hookPoolRegistered,
  hookSwap,
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

ponder.on("GPUHook:GpuFill", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { poolId, gpuId, sender, isBuy, gpuAmount, gusdAmount, protocolFee, source } =
    event.args;
  // sender is the PoolManager in-lock — attribution rides the router's
  // Buy/Sell events; the row documents it for the record.
  void sender;

  await context.db.insert(gpuFill).values({
    ...keys,
    poolId,
    gpuId,
    sender,
    isBuy,
    gpuAmount,
    gusdAmount,
    protocolFee,
    source,
  });

  const pool = await context.db.find(pools, { chainId: keys.chainId, poolId });
  if (pool === null || pool === undefined) {
    throw new Error(`GpuFill for untracked pool ${poolId}`);
  }
  // gusdAmount is gross of the fill's protocol fee; volume keeps the gross
  // gUSD the hook moved (the fee is counted separately, never netted back
  // out with negative deltas).
  const buySide = isBuy;
  await context.db.update(pools, { chainId: keys.chainId, poolId }).set({
    volumeGusd: pool.volumeGusd + gusdAmount,
    buyVolumeGusd: buySide ? pool.buyVolumeGusd + gusdAmount : pool.buyVolumeGusd,
    sellVolumeGusd: buySide ? pool.sellVolumeGusd : pool.sellVolumeGusd + gusdAmount,
    hookFeesGusd: pool.hookFeesGusd + protocolFee,
    lastSwapAtSec: keys.blockTimestamp,
    lastSwapBlockNumber: keys.blockNumber,
  });

  await bumpPoolHourBucket(context.db, keys.chainId, poolId, keys.blockTimestamp, {
    volumeGusd: gusdAmount,
    buyVolumeGusd: buySide ? gusdAmount : 0n,
    sellVolumeGusd: buySide ? 0n : gusdAmount,
    hookFeesGusd: protocolFee,
  });

  await context.db
    .insert(protocolStats)
    .values({ ...zeroProtocolStats(keys.chainId), hookFeesGusd: protocolFee })
    .onConflictDoUpdate((row) => ({
      hookFeesGusd: row.hookFeesGusd + protocolFee,
    }));

  await bumpDailyBucket(context.db, keys.chainId, keys.blockTimestamp, {
    hookFeesGusd: protocolFee,
  });

  const asset = await context.db.find(gpuAssets, {
    chainId: keys.chainId,
    gpuId,
  });
  if (asset === null || asset === undefined) {
    throw new Error(`GpuFill for untracked gpuId ${gpuId} — GpuCreated missing`);
  }
  await context.db.update(gpuAssets, { chainId: keys.chainId, gpuId }).set({
    polFeesGusd: asset.polFeesGusd + protocolFee,
  });
});

ponder.on("GPUHook:HookSwap", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { id, sender, amount0, amount1, swapFee } = event.args;
  // Lens/conformance tape only — volume and fees come from GpuFill.
  await context.db
    .insert(hookSwap)
    .values({ ...keys, poolId: id, sender, amount0, amount1, swapFee });
});

ponder.on("GPUHook:HookFeeBpsSet", async ({ event, context }) => {
  const { newFeeBps } = event.args;
  await context.db
    .insert(protocolStats)
    .values({ ...zeroProtocolStats(context.chain.id), hookFeeBps: newFeeBps })
    .onConflictDoUpdate({ hookFeeBps: newFeeBps });
});
