/**
 * GPUIssuance handlers — GPU registration and the primary market. GpuCreated
 * seeds the gpu_assets row (sku decoded from the ASCII gpuId; richer catalog
 * metadata is joined at the API from @gusd/gpu-catalog, never from chain).
 * Issued feeds the per-GPU primary-market cumulatives; the per-wallet cost
 * basis lands in the wallet projection (Phase 4).
 */
import { ponder } from "ponder:registry";
import {
  gpuAssets,
  gpuCreated,
  gpuIssued,
  gpuTokens,
  protocolStats,
} from "ponder:schema";
import { eventKeys, eventTxHash } from "../events.js";
import { decodeGpuId } from "../format.js";
import { bumpDailyBucket } from "./buckets.js";
import { recordUserEvent } from "./user-event.js";
import { recordGpuAcquisition } from "./wallet-state.js";
import { zeroProtocolStats } from "./stats.js";

ponder.on("GPUIssuance:GpuCreated", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { gpuId, token, feeBps, poolFee, tickSpacing } = event.args;

  await context.db.insert(gpuCreated).values({
    ...keys,
    gpuId,
    gpuSku: decodeGpuId(gpuId),
    token,
    feeBps,
    poolFee,
    tickSpacing,
  });

  await context.db
    .insert(gpuAssets)
    .values({
      chainId: keys.chainId,
      gpuId,
      token,
      gpuSku: decodeGpuId(gpuId),
      issuanceFeeBps: feeBps,
      issuanceEnabled: false,
      poolFee,
      tickSpacing,
      issuedGpu: 0n,
      issuedCount: 0,
      issuanceProceedsGusd: 0n,
      issuanceFeesGusd: 0n,
      reserveGusd: 0n,
      buyCount: 0,
      sellCount: 0,
      volumeGusd: 0n,
    })
    .onConflictDoUpdate({
      token,
      gpuSku: decodeGpuId(gpuId),
      issuanceFeeBps: feeBps,
      poolFee,
      tickSpacing,
    });

  // Token→gpuId PK lookup for the transfer-demotion path (gpu_assets is
  // keyed by gpuId, so a GPUToken:Transfer cannot reverse-map without this).
  await context.db
    .insert(gpuTokens)
    .values({ chainId: keys.chainId, token, gpuId })
    .onConflictDoUpdate({ gpuId });
});

ponder.on("GPUIssuance:Issued", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { gpuId, amount, base, fee } = event.args;

  await context.db.insert(gpuIssued).values({
    ...keys,
    caller: event.args.caller,
    gpuId,
    user: event.args.to,
    amount,
    base,
    fee,
  });

  await recordUserEvent(context.db, {
    keys,
    contract: event.log.address,
    event: "Issued",
    user: event.args.to,
    args: event.args,
    txHash: eventTxHash(event),
  });

  const asset = await context.db.find(gpuAssets, {
    chainId: keys.chainId,
    gpuId,
  });
  if (asset === null || asset === undefined) {
    throw new Error(`Issued for untracked gpuId ${gpuId} — GpuCreated missing`);
  }
  await context.db.update(gpuAssets, { chainId: keys.chainId, gpuId }).set({
    issuedGpu: asset.issuedGpu + amount,
    issuedCount: asset.issuedCount + 1,
    issuanceProceedsGusd: asset.issuanceProceedsGusd + base,
    issuanceFeesGusd: asset.issuanceFeesGusd + fee,
    reserveGusd: asset.reserveGusd + base,
    firstIssuedAtSec: asset.firstIssuedAtSec ?? keys.blockTimestamp,
    lastIssuedAtSec: keys.blockTimestamp,
  });

  await context.db
    .insert(protocolStats)
    .values(zeroProtocolStats(keys.chainId))
    .onConflictDoUpdate((row) => ({
      issuedGpu: row.issuedGpu + amount,
      issuedCount: row.issuedCount + 1,
      issuanceProceedsGusd: row.issuanceProceedsGusd + base,
      issuanceFeesGusd: row.issuanceFeesGusd + fee,
    }));

  await bumpDailyBucket(context.db, keys.chainId, keys.blockTimestamp, {
    issuedGpu: amount,
    issuedCount: 1,
    issuanceProceedsGusd: base,
  });

  // Cost basis: a direct issuance acquires at base+fee. A router-mediated
  // issuance leg acquires via Buy instead (all-in cost = paid) — counting
  // both would double-count the issuance leg of a router Buy.
  const routerAddress = context.contracts.GpuRouter?.address;
  if (typeof routerAddress !== "string") {
    throw new Error("GpuRouter address missing from ponder config");
  }
  if (event.args.caller.toLowerCase() !== routerAddress.toLowerCase()) {
    await recordGpuAcquisition(
      context.db,
      keys,
      event.args.to,
      gpuId,
      amount,
      base + fee,
    );
  }
});

ponder.on("GPUIssuance:MaxOracleStalenessSet", async ({ event, context }) => {
  const { seconds_ } = event.args;
  await context.db
    .insert(protocolStats)
    .values({
      ...zeroProtocolStats(context.chain.id),
      maxOracleStalenessSec: Number(seconds_),
    })
    .onConflictDoUpdate({ maxOracleStalenessSec: Number(seconds_) });
});

ponder.on("GPUIssuance:IssuanceEnabledSet", async ({ event, context }) => {
  const { gpuId, enabled } = event.args;
  const asset = await context.db.find(gpuAssets, {
    chainId: context.chain.id,
    gpuId,
  });
  if (asset === null || asset === undefined) {
    throw new Error(`IssuanceEnabledSet for untracked gpuId ${gpuId}`);
  }
  await context.db
    .update(gpuAssets, { chainId: context.chain.id, gpuId })
    .set({ issuanceEnabled: enabled });
});

ponder.on("GPUIssuance:IssuanceFeeSet", async ({ event, context }) => {
  const { gpuId, feeBps } = event.args;
  const asset = await context.db.find(gpuAssets, {
    chainId: context.chain.id,
    gpuId,
  });
  if (asset === null || asset === undefined) {
    throw new Error(`IssuanceFeeSet for untracked gpuId ${gpuId}`);
  }
  await context.db
    .update(gpuAssets, { chainId: context.chain.id, gpuId })
    .set({ issuanceFeeBps: feeBps });
});
