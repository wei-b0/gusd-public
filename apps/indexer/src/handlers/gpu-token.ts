/**
 * GPUToken handlers — child tokens discovered via the GpuCreated factory.
 * Transfers feed the authoritative balance projection and, when they are
 * wallet-to-wallet moves, demote the affected wallets' cost basis (rev 2:
 * transfers never move basis with invented cost — they only destroy its
 * completeness). Never projected into user activity directly.
 */
import { ponder } from "ponder:registry";
import { gpuTokens, tokenTransfer } from "ponder:schema";
import { eventKeys } from "../events.js";
import { balanceChanges } from "../projections/balances.js";
import {
  applyBalanceDelta,
  demoteGpuBasis,
  isUserWallet,
  protocolContractAddresses,
} from "./wallet-state.js";

ponder.on("GPUToken:Transfer", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { from, to, value } = event.args;
  const token = event.log.address;
  await context.db
    .insert(tokenTransfer)
    .values({ ...keys, token, from, to, value });

  for (const change of balanceChanges({ from, to, value })) {
    await applyBalanceDelta(context.db, keys, token, change.wallet, change.delta);
  }

  // Wallet-to-wallet GPU moves make both sides' basis unattributable: the
  // receiver's units have no recorded cost, the sender's disposal has no
  // protocol event. Protocol-contract legs (PM-held pool liquidity, router
  // forwarding, issuance mint from 0x0) are the flows already counted.
  const contracts = protocolContractAddresses(context);
  if (isUserWallet(from, contracts) && isUserWallet(to, contracts)) {
    const mapping = await context.db.find(gpuTokens, {
      chainId: keys.chainId,
      token,
    });
    if (mapping === null || mapping === undefined) {
      throw new Error(
        `GPUToken transfer for unregistered token ${token} — GpuCreated missing`,
      );
    }
    await demoteGpuBasis(context.db, keys, from, mapping.gpuId);
    await demoteGpuBasis(context.db, keys, to, mapping.gpuId);
  }
});
