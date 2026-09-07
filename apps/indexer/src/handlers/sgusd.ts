/**
 * sgUSD handlers — the staking vault (ERC-4626 over gUSD). Seeded is the
 * one-way bootstrap (owner = the sgUSD contract itself; the API filters
 * contract addresses from wallet-facing surfaces). Revenue arrives at the
 * vault as bare gUSD transfers correlated with RevenueLedger.Distributed.
 */
import { ponder } from "ponder:registry";
import {
  sgusdDeposited,
  sgusdSeeded,
  sgusdVault,
  sgusdWithdrawn,
  tokenTransfer,
} from "ponder:schema";
import { eventKeys, eventTxHash } from "../events.js";
import { balanceChanges } from "../projections/balances.js";
import { recordUserEvent } from "./user-event.js";
import {
  applyBalanceDelta,
  demoteVaultPosition,
  isUserWallet,
  protocolContractAddresses,
  recordVaultDeposit,
  recordVaultWithdraw,
} from "./wallet-state.js";
import { zeroSgusdVault } from "./stats.js";

ponder.on("sgUSD:Deposit", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { sender, owner, assets, shares } = event.args;

  await context.db
    .insert(sgusdDeposited)
    .values({ ...keys, sender, owner, assets, shares });

  await recordUserEvent(context.db, {
    keys,
    contract: event.log.address,
    event: "Deposit",
    user: owner,
    args: event.args,
    txHash: eventTxHash(event),
  });

  // Stake position basis: assets in for shares minted (WAC in gUSD terms).
  await recordVaultDeposit(context.db, keys, owner, assets, shares);

  await context.db
    .insert(sgusdVault)
    .values(zeroSgusdVault(keys.chainId))
    .onConflictDoUpdate((row) => ({
      depositsGusd: row.depositsGusd + assets,
      sharesMinted: row.sharesMinted + shares,
      depositCount: row.depositCount + 1,
    }));
});

ponder.on("sgUSD:Withdraw", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { sender, receiver, owner, assets, shares } = event.args;

  await context.db
    .insert(sgusdWithdrawn)
    .values({ ...keys, sender, receiver, owner, assets, shares });

  await recordUserEvent(context.db, {
    keys,
    contract: event.log.address,
    event: "Withdraw",
    user: owner,
    args: event.args,
    txHash: eventTxHash(event),
  });

  // Unstake: shares burned at average cost, realized against assets out.
  await recordVaultWithdraw(context.db, keys, owner, assets, shares);

  await context.db
    .insert(sgusdVault)
    .values(zeroSgusdVault(keys.chainId))
    .onConflictDoUpdate((row) => ({
      withdrawsGusd: row.withdrawsGusd + assets,
      sharesBurned: row.sharesBurned + shares,
      withdrawCount: row.withdrawCount + 1,
    }));
});

ponder.on("sgUSD:Seeded", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { assets } = event.args;

  await context.db.insert(sgusdSeeded).values({ ...keys, assets });

  await context.db
    .insert(sgusdVault)
    .values(zeroSgusdVault(keys.chainId))
    .onConflictDoUpdate((row) => ({
      seededGusd: row.seededGusd + assets,
    }));
});

ponder.on("sgUSD:Transfer", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { from, to, value } = event.args;
  await context.db
    .insert(tokenTransfer)
    .values({ ...keys, token: event.log.address, from, to, value });

  for (const change of balanceChanges({ from, to, value })) {
    await applyBalanceDelta(
      context.db,
      keys,
      event.log.address,
      change.wallet,
      change.delta,
    );
  }

  // Wallet-to-wallet share moves leave the vault basis unattributable on
  // both sides (mint/burn via 0x0 and protocol-contract legs are excluded —
  // those are the Deposit/Withdraw flows already counted).
  const contracts = protocolContractAddresses(context);
  if (isUserWallet(from, contracts) && isUserWallet(to, contracts)) {
    await demoteVaultPosition(context.db, keys, from);
    await demoteVaultPosition(context.db, keys, to);
  }
});
