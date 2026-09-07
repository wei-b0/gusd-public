/**
 * StableRouter handlers — stable-funded gUSD mint/redeem. These rows carry
 * the stable leg only: the user's gUSD leg already appears as GUSD:Minted /
 * GUSD:Redeemed (StableRouter calls gUSD.mint internally) — never
 * double-counted. StableUpdated (whitelist config, no consumer) is
 * deliberately not fetched — see abis.ts.
 */
import { ponder } from "ponder:registry";
import { stableMintViaSwap, stableRedeemViaSwap } from "ponder:schema";
import { eventKeys } from "../events.js";

ponder.on("StableRouter:MintedViaSwap", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { stable, to, amountIn, underlyingOut, gusdOut } = event.args;
  await context.db
    .insert(stableMintViaSwap)
    .values({ ...keys, stable, user: to, amountIn, underlyingOut, gusdOut });
});

ponder.on("StableRouter:RedeemedViaSwap", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { stable, to, gusdIn, underlyingIn, stableOut } = event.args;
  await context.db
    .insert(stableRedeemViaSwap)
    .values({ ...keys, stable, user: to, gusdIn, underlyingIn, stableOut });
});
