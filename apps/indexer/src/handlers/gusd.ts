/**
 * GUSD handlers — the settlement asset's user legs. StableRouter.mint calls
 * gUSD.mint internally, so stable-funded mints already surface here (one row
 * per economic action, never double-counted). Transfer rows feed the raw
 * token history; balance projections are a separate, later pass.
 */
import { handlers } from "../envio-compat.js";
import {
  gusdMinted,
  gusdRedeemed,
  protocolStats,
  tokenTransfer,
} from "../schema.js";
import { eventKeys, eventTxHash } from "../events.js";
import { balanceChanges } from "../projections/balances.js";
import { bumpDailyBucket } from "./buckets.js";
import { recordUserEvent } from "./user-event.js";
import { applyBalanceDelta } from "./wallet-state.js";
import { zeroProtocolStats } from "./stats.js";

handlers.on("GUSD:Minted", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { to, underlyingIn, gusdOut } = event.args;

  await context.db.insert(gusdMinted).values({
    ...keys,
    user: to,
    underlyingIn,
    gusdOut,
    fee: event.args.fee,
  });

  await recordUserEvent(context.db, {
    keys,
    contract: event.log.address,
    event: "Minted",
    user: to,
    args: event.args,
    txHash: eventTxHash(event),
  });

  await context.db
    .insert(protocolStats)
    .values({ ...zeroProtocolStats(keys.chainId), gusdMintedGusd: gusdOut, mintCount: 1 })
    .onConflictDoUpdate((row: any) => ({
      gusdMintedGusd: row.gusdMintedGusd + gusdOut,
      mintCount: row.mintCount + 1,
    }));

  await bumpDailyBucket(context.db, keys.chainId, keys.blockTimestamp, {
    mintedGusd: gusdOut,
    mintCount: 1,
  });
});

handlers.on("GUSD:Redeemed", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { from, gusdIn, underlyingOut, fee } = event.args;

  await context.db.insert(gusdRedeemed).values({
    ...keys,
    user: from,
    gusdIn,
    underlyingOut,
    fee,
  });

  await recordUserEvent(context.db, {
    keys,
    contract: event.log.address,
    event: "Redeemed",
    user: from,
    args: event.args,
    txHash: eventTxHash(event),
  });

  await context.db
    .insert(protocolStats)
    .values({ ...zeroProtocolStats(keys.chainId), gusdRedeemedGusd: gusdIn, redeemCount: 1 })
    .onConflictDoUpdate((row: any) => ({
      gusdRedeemedGusd: row.gusdRedeemedGusd + gusdIn,
      redeemCount: row.redeemCount + 1,
    }));

  await bumpDailyBucket(context.db, keys.chainId, keys.blockTimestamp, {
    redeemedGusd: gusdIn,
    redeemCount: 1,
  });
});

handlers.on("GUSD:FeesUpdated", async ({ event, context }) => {
  const { mintFeeBps, redeemFeeBps } = event.args;
  await context.db
    .insert(protocolStats)
    .values({
      ...zeroProtocolStats(context.chain.id),
      mintFeeBps,
      redeemFeeBps,
    })
    .onConflictDoUpdate({ mintFeeBps, redeemFeeBps });
});

handlers.on("GUSD:Transfer", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { from, to, value } = event.args;
  await context.db
    .insert(tokenTransfer)
    .values({ ...keys, token: event.log.address, from, to, value });

  // Authoritative balances. gUSD is the quote asset — raw transfers never
  // touch cost basis (that lives on the GPU/vault side). The zero address
  // never gets a row (mint/burn); contract-addressed rows are kept —
  // per-address reads never touch them.
  for (const change of balanceChanges({ from, to, value })) {
    await applyBalanceDelta(
      context.db,
      keys,
      event.log.address,
      change.wallet,
      change.delta,
    );
  }
});
