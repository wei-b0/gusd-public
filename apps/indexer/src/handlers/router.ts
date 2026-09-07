/**
 * GpuRouter handlers — routed executions (rev 2: NEVER merged with the AMM
 * swap tape). One Buy = one pool leg + one issuance leg (+ fees) and
 * corresponds to one PoolManager.Swap, one Issued and one TradingFeeAccrued
 * across other tables — the endpoints present them separately. Routed
 * volume lands on gpu_assets/protocol_stats only; pool volume stays on the
 * Swap path exclusively.
 */
import { ponder } from "ponder:registry";
import { gpuAssets, protocolStats, routerBuy, routerSell } from "ponder:schema";
import { eventKeys, eventTxHash } from "../events.js";
import { bumpDailyBucket } from "./buckets.js";
import { recordUserEvent } from "./user-event.js";
import {
  recordGpuAcquisition,
  recordGpuDisposal,
} from "./wallet-state.js";
import { zeroProtocolStats } from "./stats.js";

ponder.on("GpuRouter:Buy", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const {
    gpuId,
    recipient,
    payer,
    gpuOut,
    paid,
    poolGpuOut,
    issueGpuOut,
    hookFee,
    issuanceFee,
  } = event.args;

  await context.db.insert(routerBuy).values({
    ...keys,
    gpuId,
    recipient,
    payer,
    gpuOut,
    paid,
    poolGpuOut,
    issueGpuOut,
    hookFee,
    issuanceFee,
  });

  await recordUserEvent(context.db, {
    keys,
    contract: event.log.address,
    event: "Buy",
    user: recipient,
    args: event.args,
    txHash: eventTxHash(event),
  });

  // Cost basis: all-in cost = paid (pool spend + hook fee + issuance fee).
  // The router's own Issued leg (caller = router) is deliberately not a
  // second acquisition.
  await recordGpuAcquisition(context.db, keys, recipient, gpuId, gpuOut, paid);

  const asset = await context.db.find(gpuAssets, {
    chainId: keys.chainId,
    gpuId,
  });
  if (asset === null || asset === undefined) {
    throw new Error(`Buy for untracked gpuId ${gpuId} — GpuCreated missing`);
  }
  await context.db.update(gpuAssets, { chainId: keys.chainId, gpuId }).set({
    buyCount: asset.buyCount + 1,
    volumeGusd: asset.volumeGusd + paid,
    lastTradeAtSec: keys.blockTimestamp,
  });

  await context.db
    .insert(protocolStats)
    .values(zeroProtocolStats(keys.chainId))
    .onConflictDoUpdate((row) => ({
      buyCount: row.buyCount + 1,
      buyVolumeGusd: row.buyVolumeGusd + paid,
    }));

  await bumpDailyBucket(context.db, keys.chainId, keys.blockTimestamp, {
    buyVolumeGusd: paid,
    buyCount: 1,
  });
});

ponder.on("GpuRouter:Sell", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { gpuId, recipient, gpuIn, out, hookFee } = event.args;

  await context.db
    .insert(routerSell)
    .values({ ...keys, gpuId, recipient, gpuIn, out, hookFee });

  await recordUserEvent(context.db, {
    keys,
    contract: event.log.address,
    event: "Sell",
    user: recipient,
    args: event.args,
    txHash: eventTxHash(event),
  });

  // Disposal: out is the gUSD-equivalent received for gpuIn (6-dec 1:1).
  await recordGpuDisposal(context.db, keys, recipient, gpuId, gpuIn, out);

  const asset = await context.db.find(gpuAssets, {
    chainId: keys.chainId,
    gpuId,
  });
  if (asset === null || asset === undefined) {
    throw new Error(`Sell for untracked gpuId ${gpuId} — GpuCreated missing`);
  }
  await context.db.update(gpuAssets, { chainId: keys.chainId, gpuId }).set({
    sellCount: asset.sellCount + 1,
    volumeGusd: asset.volumeGusd + out,
    lastTradeAtSec: keys.blockTimestamp,
  });

  await context.db
    .insert(protocolStats)
    .values(zeroProtocolStats(keys.chainId))
    .onConflictDoUpdate((row) => ({
      sellCount: row.sellCount + 1,
      sellVolumeGusd: row.sellVolumeGusd + out,
    }));

  await bumpDailyBucket(context.db, keys.chainId, keys.blockTimestamp, {
    sellVolumeGusd: out,
    sellCount: 1,
  });
});
