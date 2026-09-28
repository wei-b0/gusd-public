/**
 * GpuOracle handlers — consumption attestations are transparency/health/
 * comparison data ONLY (hard boundary): they never feed display prices,
 * which come from the offchain benchmark pipeline. Every trade embeds and
 * consumes one signed report (the pull oracle), so PriceConsumed IS the
 * market's price history; the state row mirrors the last consumed report.
 */
import { handlers } from "../envio-compat.js";
import {
  priceConsumed,
  signerAccepted,
  signerTransferStarted,
  gpuOracleState,
  protocolStats,
} from "../schema.js";
import { eventKeys } from "../events.js";
import { zeroProtocolStats } from "./stats.js";

handlers.on("GpuOracle:PriceConsumed", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { gpuId, price, epoch, observedAt, reportHash, caller } = event.args;

  await context.db.insert(priceConsumed).values({
    ...keys,
    gpuId,
    price,
    epoch: BigInt(epoch),
    observedAtSec: Number(observedAt),
    reportHash,
    caller,
  });

  await context.db
    .insert(gpuOracleState)
    .values({
      chainId: keys.chainId,
      gpuId,
      price,
      observedAtSec: Number(observedAt),
      epoch: BigInt(epoch),
      reportHash,
      caller,
      lastConsumedBlockNumber: keys.blockNumber,
    })
    .onConflictDoUpdate({
      price,
      observedAtSec: Number(observedAt),
      epoch: BigInt(epoch),
      reportHash,
      caller,
      lastConsumedBlockNumber: keys.blockNumber,
    });
});

handlers.on("GpuOracle:SignerTransferStarted", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { currentSigner, nextSigner } = event.args;

  await context.db
    .insert(signerTransferStarted)
    .values({ ...keys, currentSigner, nextSigner });
});

handlers.on("GpuOracle:SignerAccepted", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { previousSigner, newSigner } = event.args;

  await context.db.insert(signerAccepted).values({ ...keys, previousSigner, newSigner });

  // Signer is per-oracle (global), so it mirrors into the protocol_stats
  // singleton — the per-GPU gpu_oracle_state table has no signer column.
  await context.db
    .insert(protocolStats)
    .values({ ...zeroProtocolStats(keys.chainId), attestor: newSigner })
    .onConflictDoUpdate({ attestor: newSigner });
});

handlers.on("GpuOracle:EpochLengthSet", async ({ event, context }) => {
  const { seconds_ } = event.args;
  await context.db
    .insert(protocolStats)
    .values({ ...zeroProtocolStats(context.chain.id), epochLengthSec: seconds_ })
    .onConflictDoUpdate({ epochLengthSec: seconds_ });
});

handlers.on("GpuOracle:MaxObservationAgeSet", async ({ event, context }) => {
  const { seconds_ } = event.args;
  await context.db
    .insert(protocolStats)
    .values({ ...zeroProtocolStats(context.chain.id), maxObservationAgeSec: seconds_ })
    .onConflictDoUpdate({ maxObservationAgeSec: seconds_ });
});
