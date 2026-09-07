/**
 * GPUPriceOracle handlers — indexed oracle publications are
 * transparency/health/comparison data ONLY (hard boundary): they never feed
 * display prices, which come from the offchain benchmark pipeline. The
 * oracle's `updatedAt` is the contract's staleness input, not a market tick.
 */
import { ponder } from "ponder:registry";
import {
  oraclePriceOverridden,
  oraclePricePublished,
  oraclePublisherAccepted,
  oracleState,
  protocolStats,
} from "ponder:schema";
import { eventKeys } from "../events.js";
import { zeroProtocolStats } from "./stats.js";

ponder.on("GPUPriceOracle:PricePublished", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { gpuId, price, updatedAt, previousPrice } = event.args;

  await context.db.insert(oraclePricePublished).values({
    ...keys,
    gpuId,
    price,
    previousPrice,
    updatedAtSec: Number(updatedAt),
  });

  await context.db
    .insert(oracleState)
    .values({
      chainId: keys.chainId,
      gpuId,
      price,
      previousPrice,
      updatedAtSec: Number(updatedAt),
      lastPublishedBlockNumber: keys.blockNumber,
    })
    .onConflictDoUpdate({
      price,
      previousPrice,
      updatedAtSec: Number(updatedAt),
      lastPublishedBlockNumber: keys.blockNumber,
    });
});

ponder.on("GPUPriceOracle:PriceOverridden", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { gpuId, price, updatedAt } = event.args;

  await context.db.insert(oraclePriceOverridden).values({
    ...keys,
    gpuId,
    price,
    updatedAtSec: Number(updatedAt),
  });

  // The owner hatch seeds the live value too — an override IS the current
  // published price until the next publication.
  await context.db
    .insert(oracleState)
    .values({
      chainId: keys.chainId,
      gpuId,
      price,
      previousPrice: 0n,
      updatedAtSec: Number(updatedAt),
      overriddenPrice: price,
      overriddenAtSec: Number(updatedAt),
      lastPublishedBlockNumber: keys.blockNumber,
    })
    .onConflictDoUpdate({
      price,
      updatedAtSec: Number(updatedAt),
      overriddenPrice: price,
      overriddenAtSec: Number(updatedAt),
      lastPublishedBlockNumber: keys.blockNumber,
    });
});

ponder.on("GPUPriceOracle:PublisherAccepted", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { previousPublisher, newPublisher } = event.args;

  await context.db
    .insert(oraclePublisherAccepted)
    .values({ ...keys, previousPublisher, newPublisher });

  // Publisher is per-oracle (global), so it mirrors into the protocol_stats
  // singleton — the per-GPU oracle_state table has no publisher column.
  await context.db
    .insert(protocolStats)
    .values({ ...zeroProtocolStats(keys.chainId), publisher: newPublisher })
    .onConflictDoUpdate({ publisher: newPublisher });
});

ponder.on("GPUPriceOracle:MaxDeviationBpsSet", async ({ event, context }) => {
  const { bps } = event.args;
  await context.db
    .insert(protocolStats)
    .values({ ...zeroProtocolStats(context.chain.id), maxDeviationBps: bps })
    .onConflictDoUpdate({ maxDeviationBps: bps });
});
