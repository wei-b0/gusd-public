/**
 * GPUMarketLiquidity (POL) handlers — oracle-anchored bid/ask bands funded
 * by primary principal. BandPlaced/BandRemoved track where market liquidity
 * sits (liquidity_bands); FeesCollected accumulates the two-currency fee
 * sweep onto gpu_assets (gUSD → revenue ledger, GPU → ask inventory).
 *
 * PrincipalPending is deliberately unhandled: Issued.base already accumulates
 * principalContributedGusd (same amount, same block). Recentred is
 * derivable from its BandRemoved children.
 */
import { ponder } from "ponder:registry";
import { gpuAssets, liquidityBands } from "ponder:schema";
import { eventKeys } from "../events.js";

ponder.on("GPUMarketLiquidity:BandPlaced", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { gpuId, poolId, tickLower, tickUpper, liquidity, gusdPlaced, gpuPlaced, bidSide } =
    event.args;
  // liquidity is the point-in-time amount; live depth is pool state, not a
  // log — the band row records placement provenance only.
  void liquidity;

  await context.db
    .insert(liquidityBands)
    .values({
      chainId: keys.chainId,
      gpuId,
      poolId,
      tickLower,
      tickUpper,
      bidSide,
      gusdPlaced,
      gpuPlaced,
      placementCount: 1,
      firstPlacedAtSec: keys.blockTimestamp,
      lastPlacedAtSec: keys.blockTimestamp,
      removedAtSec: null,
    })
    .onConflictDoUpdate((row) => ({
      bidSide,
      gusdPlaced,
      gpuPlaced,
      placementCount: row.placementCount + 1,
      lastPlacedAtSec: keys.blockTimestamp,
      removedAtSec: null,
    }));
});

ponder.on("GPUMarketLiquidity:BandRemoved", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { gpuId, poolId, tickLower, tickUpper } = event.args;
  // recoveredGusd/recoveredGpu are recenter proceeds that immediately
  // re-place (emitting their own BandPlaced) — not persisted separately.
  await context.db
    .insert(liquidityBands)
    .values({
      chainId: keys.chainId,
      gpuId,
      poolId,
      tickLower,
      tickUpper,
      bidSide: true, // placeholder for the impossible no-prior-placement path
      gusdPlaced: 0n,
      gpuPlaced: 0n,
      placementCount: 0,
      firstPlacedAtSec: keys.blockTimestamp,
      lastPlacedAtSec: keys.blockTimestamp,
      removedAtSec: keys.blockTimestamp,
    })
    .onConflictDoUpdate({ removedAtSec: keys.blockTimestamp });
});

ponder.on("GPUMarketLiquidity:FeesCollected", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { gpuId, gusdToLedger, gpuToInventory } = event.args;

  const asset = await context.db.find(gpuAssets, {
    chainId: keys.chainId,
    gpuId,
  });
  if (asset === null || asset === undefined) {
    throw new Error(`FeesCollected for untracked gpuId ${gpuId} — GpuCreated missing`);
  }
  await context.db.update(gpuAssets, { chainId: keys.chainId, gpuId }).set({
    marketFeesGusd: asset.marketFeesGusd + gusdToLedger,
    marketFeesGpu: asset.marketFeesGpu + gpuToInventory,
  });
});
