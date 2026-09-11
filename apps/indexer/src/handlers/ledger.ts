/**
 * RevenueLedger handlers — revenue splits to the sgUSD vault + treasury.
 * The vault's actual accrual arrives as a bare gUSD transfer; Distributed
 * carries the split amounts and is the correlated accrual signal (added to
 * sgusd_vault.revenueGusd here).
 */
import { ponder } from "ponder:registry";
import { protocolStats, revenueDistributed, sgusdVault } from "ponder:schema";
import { eventKeys } from "../events.js";
import { bumpDailyBucket } from "./buckets.js";
import { zeroProtocolStats, zeroSgusdVault } from "./stats.js";

ponder.on("RevenueLedger:Distributed", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { amount, toVault, toTreasury } = event.args;

  await context.db
    .insert(revenueDistributed)
    .values({ ...keys, amount, toVault, toTreasury });

  await context.db
    .insert(protocolStats)
    .values({
      ...zeroProtocolStats(keys.chainId),
      revenueDistributedGusd: amount,
      revenueToVaultGusd: toVault,
      revenueToTreasuryGusd: toTreasury,
    })
    .onConflictDoUpdate((row) => ({
      revenueDistributedGusd: row.revenueDistributedGusd + amount,
      revenueToVaultGusd: row.revenueToVaultGusd + toVault,
      revenueToTreasuryGusd: row.revenueToTreasuryGusd + toTreasury,
    }));

  await context.db
    .insert(sgusdVault)
    .values({ ...zeroSgusdVault(keys.chainId), revenueGusd: toVault })
    .onConflictDoUpdate((row) => ({
      revenueGusd: row.revenueGusd + toVault,
    }));

  await bumpDailyBucket(context.db, keys.chainId, keys.blockTimestamp, {
    revenueDistributedGusd: amount,
  });
});

ponder.on("RevenueLedger:SplitUpdated", async ({ event, context }) => {
  const { sgUSDBps } = event.args;
  await context.db
    .insert(protocolStats)
    .values({ ...zeroProtocolStats(context.chain.id), sgusdSplitBps: sgUSDBps })
    .onConflictDoUpdate({ sgusdSplitBps: sgUSDBps });
});

ponder.on("RevenueLedger:RecipientsUpdated", async ({ event, context }) => {
  const { vault, treasury } = event.args;
  await context.db
    .insert(protocolStats)
    .values({ ...zeroProtocolStats(context.chain.id), vault, treasury })
    .onConflictDoUpdate({ vault, treasury });
});
