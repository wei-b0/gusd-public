/**
 * PositionManager handlers — the v4-periphery LP surface. ModifyPosition
 * mirrors PoolManager.ModifyLiquidity but its `sender` is the end user (the
 * unlock locker), so it owns the pool_liquidity_positions first/lastModifier
 * stamps; the PM-level handler (which runs first, inside the unlock) manages
 * liquidity and counts. There is no tokenId in ModifyPosition — per-token
 * ownership stays deferred; the ERC-721 Transfer event is intentionally not
 * indexed (the posm_transfer table was removed in the Envio migration — it
 * had zero readers).
 */
import { handlers } from "../envio-compat.js";
import {
  poolLiquidityPositions,
  posmPositionModified,
} from "../schema.js";
import { eventKeys } from "../events.js";

handlers.on("PositionManager:ModifyPosition", async ({ event, context }) => {
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
