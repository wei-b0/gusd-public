/**
 * PoolManager handlers — the v4 singleton, source-filtered on canonical pool
 * ids (rev 2), so every event here is a protocol pool. Initialize normally
 * precedes GPUHook.PoolRegistered within the same transaction (the hook's
 * afterInitialize runs after the Initialize log), so it seeds the pools row
 * with canonical=false and PoolRegistered flips the flag.
 *
 * Swap semantics (verified against lib/v4-core/src/PoolManager.sol — swap()
 * returns and emits the CALLER's delta): amount0/amount1 are the SWAPPER's
 * deltas, negative = the swapper paid that currency in. The swapper paid
 * gUSD ⇔ the pool received gUSD ⇔ the user bought GPU with gUSD (isBuy),
 * under either currency ordering via pools.gusdIsCurrency0. A swap the
 * hook covers entirely (native leg fully absorbed) emits 0/0 deltas at an
 * unchanged price — those rows land on the pm_swap tape with swapCount
 * only; their economics arrive through GpuFill on the same tx (never
 * double-counted here).
 */
import { ponder } from "ponder:registry";
import {
  pmDonate,
  pmLiquidityModified,
  pmPoolInitialized,
  pmSwap,
  poolLiquidityPositions,
  pools,
  protocolStats,
} from "ponder:schema";
import { eventKeys } from "../events.js";
import { bumpPoolHourBucket } from "./buckets.js";
import { zeroProtocolStats } from "./stats.js";

/** v4 fee units: 1_000_000 = 100% (3000 = 0.3%). */
const FEE_DENOMINATOR = 1_000_000n;

ponder.on("PoolManager:Initialize", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const {
    id,
    currency0,
    currency1,
    fee,
    tickSpacing,
    hooks,
    sqrtPriceX96,
    tick,
  } = event.args;

  await context.db.insert(pmPoolInitialized).values({
    ...keys,
    poolId: id,
    currency0,
    currency1,
    fee,
    tickSpacing,
    hooks,
    sqrtPriceX96,
    tick,
  });

  await context.db
    .insert(pools)
    .values({
      ...keys,
      poolId: id,
      canonical: false,
      currency0,
      currency1,
      fee,
      tickSpacing,
      hooks,
      sqrtPriceX96,
      tick,
      swapCount: 0,
      volumeGusd: 0n,
      buyVolumeGusd: 0n,
      sellVolumeGusd: 0n,
      hookFeesGusd: 0n,
      lpFeesGusdEst: 0n,
      harvestedFeesGusd: 0n,
    })
    .onConflictDoUpdate({
      currency0,
      currency1,
      fee,
      tickSpacing,
      hooks,
      sqrtPriceX96,
      tick,
    });
});

ponder.on("PoolManager:Swap", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { id, sender, amount0, amount1, sqrtPriceX96, liquidity, tick, fee } =
    event.args;

  await context.db.insert(pmSwap).values({
    ...keys,
    poolId: id,
    sender,
    amount0,
    amount1,
    sqrtPriceX96,
    liquidity,
    tick,
    fee,
  });

  // Fully hook-covered swap: core deltas are 0/0 at an unchanged price —
  // tape row + swap counter only; GpuFill carries the economics.
  const fullyCovered = event.args.amount0 === 0n && event.args.amount1 === 0n;

  const pool = await context.db.find(pools, {
    chainId: keys.chainId,
    poolId: id,
  });
  if (pool === null || pool === undefined) {
    throw new Error(
      `Swap for untracked pool ${id} — canonicality order violated`,
    );
  }
  if (pool.gusdIsCurrency0 === null || pool.gusdIsCurrency0 === undefined) {
    // Set by PoolRegistered; a swap cannot precede registration (the hook
    // refuses to trade unregistered pools), so this is a loud invariant break.
    throw new Error(
      `Swap on pool ${id} before its currency ordering was known`,
    );
  }
  // v4 Swap deltas are the SWAPPER's balance delta: negative = the swapper
  // paid that currency in. The swapper paid gUSD ⇔ the pool received gUSD ⇔
  // the user bought GPU with gUSD.
  const gusdDelta = pool.gusdIsCurrency0
    ? event.args.amount0
    : event.args.amount1;
  // Absolute value without Math.abs — bigint-safe, no precision loss.
  const gusdMoved = gusdDelta < 0n ? -gusdDelta : gusdDelta;
  const isBuy = gusdDelta < 0n;
  // LP fees accrue on the pool's input side; only estimated when that input
  // is gUSD (named _Est deliberately — GPU-side inputs need price data).
  const lpFeeEst = isBuy ? (gusdMoved * BigInt(fee)) / FEE_DENOMINATOR : 0n;

  await context.db.update(pools, { chainId: keys.chainId, poolId: id }).set({
    sqrtPriceX96,
    liquidity,
    tick,
    swapCount: pool.swapCount + 1,
    volumeGusd: pool.volumeGusd + gusdMoved,
    buyVolumeGusd: isBuy ? pool.buyVolumeGusd + gusdMoved : pool.buyVolumeGusd,
    sellVolumeGusd: isBuy
      ? pool.sellVolumeGusd
      : pool.sellVolumeGusd + gusdMoved,
    lpFeesGusdEst: pool.lpFeesGusdEst + lpFeeEst,
    lastSwapAtSec: keys.blockTimestamp,
    lastSwapBlockNumber: keys.blockNumber,
  });

  if (fullyCovered) return;

  await context.db
    .insert(protocolStats)
    .values({ ...zeroProtocolStats(keys.chainId), lpFeesGusdEst: lpFeeEst })
    .onConflictDoUpdate((row) => ({
      lpFeesGusdEst: row.lpFeesGusdEst + lpFeeEst,
    }));

  // Hourly bucket: the same deltas the pool cumulatives just took. Hook-fill
  // volume and fees land in the SAME bucket through the GpuFill handler
  // (same tx → same block timestamp → same bucket), so bucket sums
  // reconcile with the pool cumulatives.
  await bumpPoolHourBucket(
    context.db,
    keys.chainId,
    id,
    keys.blockTimestamp,
    {
      volumeGusd: gusdMoved,
      buyVolumeGusd: isBuy ? gusdMoved : 0n,
      sellVolumeGusd: isBuy ? 0n : gusdMoved,
      buys: isBuy ? 1 : 0,
      sells: isBuy ? 0 : 1,
      lpFeesGusdEst: lpFeeEst,
      swaps: 1,
    },
  );
});

ponder.on("PoolManager:ModifyLiquidity", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { id, sender, tickLower, tickUpper, liquidityDelta, salt } = event.args;

  await context.db.insert(pmLiquidityModified).values({
    ...keys,
    poolId: id,
    sender,
    tickLower,
    tickUpper,
    liquidityDelta,
    salt,
  });

  // Pool-level LP book. first/lastModifier are stamped on insert only — the
  // PositionManager:ModifyPosition handler overwrites them with the end user
  // (POSM runs after the unlock in the same transaction; PM events come
  // first). modifyCount counts pool-level modifications.
  await context.db
    .insert(poolLiquidityPositions)
    .values({
      chainId: keys.chainId,
      poolId: id,
      tickLower,
      tickUpper,
      salt,
      liquidity: liquidityDelta,
      firstModifier: sender,
      lastModifier: sender,
      modifyCount: 1,
      firstModifiedAtSec: keys.blockTimestamp,
      lastModifiedAtSec: keys.blockTimestamp,
    })
    .onConflictDoUpdate((row) => ({
      liquidity: row.liquidity + liquidityDelta,
      modifyCount: row.modifyCount + 1,
      lastModifiedAtSec: keys.blockTimestamp,
    }));
});

ponder.on("PoolManager:Donate", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { id, sender, amount0, amount1 } = event.args;

  await context.db.insert(pmDonate).values({
    ...keys,
    poolId: id,
    sender,
    amount0,
    amount1,
  });
});
