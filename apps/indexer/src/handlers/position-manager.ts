/**
 * PositionManager handlers — the v4-periphery LP surface. ModifyPosition
 * mirrors PoolManager.ModifyLiquidity but its `sender` is the end user (the
 * unlock locker), so it owns the pool_liquidity_positions first/lastModifier
 * stamps; the PM-level handler (which runs first, inside the unlock) manages
 * liquidity and counts. There is no tokenId in ModifyPosition — per-token
 * ownership stays deferred; the ERC-721 Transfer history captured here is
 * the future correlation input.
 */
import { ponder } from "ponder:registry";
import {
  poolLiquidityPositions,
  posmPositionModified,
  posmTransfer,
} from "ponder:schema";
import { eventKeys } from "../events.js";

ponder.on("PositionManager:ModifyPosition", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { id, sender, tickLower, tickUpper, liquidityDelta, salt } = event.args;

  await context.db.insert(posmPositionModified).values({
    ...keys,
    poolId: id,
    sender,
    tickLower,
    tickUpper,
    liquidityDelta,
    salt,
  });

  // Stamp the end user. The row already exists (the PM-level event inside
  // this same unlock ran first) — onConflictDoUpdate keeps the handler total
  // even if ordering ever changes.
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
      modifyCount: 0,
      firstModifiedAtSec: keys.blockTimestamp,
      lastModifiedAtSec: keys.blockTimestamp,
    })
    .onConflictDoUpdate({
      firstModifier: sender,
      lastModifier: sender,
      lastModifiedAtSec: keys.blockTimestamp,
    });
});

ponder.on("PositionManager:Transfer", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  // ERC-721: from/to (indexed), tokenId (indexed); every minted position
  // token has amount 1 by construction.
  const { from, to, id: tokenId } = event.args;

  await context.db.insert(posmTransfer).values({
    ...keys,
    tokenId,
    from,
    to,
  });
});
