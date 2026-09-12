/**
 * GPUMarketLiquidity handlers — the market-making inventory vault
 * (hook-only custody). BidCredited/GpuNoted/InventoryPulled delta-track the
 * per-market POL inventories on gpu_assets: polGusd (bid-side gUSD that
 * buys the next sell) and polGpu (ask-side GPU inventory that sells into
 * the next buy). Executable sell depth is polGusd priced at the bid edge —
 * honestly finite, per market.
 *
 * PrincipalNoted is deliberately unhandled: Issued.base already accumulates
 * principalContributedGusd (same amount, same tx — direct and in-swap
 * issuance both flow through notePrincipal).
 */
import { handlers } from "../envio-compat.js";
import { gpuAssets } from "../schema.js";
import { eventKeys } from "../events.js";

/** Fetches the asset row or fails loudly — every vault event postdates
 *  GpuCreated for its gpuId. */
async function requireAsset(
  context: { db: any },
  chainId: number,
  gpuId: string,
  what: string,
) {
  const asset = await context.db.find(gpuAssets, { chainId, gpuId });
  if (asset === null || asset === undefined) {
    throw new Error(`${what} for untracked gpuId ${gpuId} — GpuCreated missing`);
  }
  return asset;
}

handlers.on("GPUMarketLiquidity:BidCredited", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { gpuId, amount } = event.args;
  const asset = await requireAsset(context, keys.chainId, gpuId, "BidCredited");
  await context.db.update(gpuAssets, { chainId: keys.chainId, gpuId }).set({
    polGusd: asset.polGusd + amount,
  });
});

handlers.on("GPUMarketLiquidity:GpuNoted", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { gpuId, amount } = event.args;
  const asset = await requireAsset(context, keys.chainId, gpuId, "GpuNoted");
  await context.db.update(gpuAssets, { chainId: keys.chainId, gpuId }).set({
    polGpu: asset.polGpu + amount,
  });
});

handlers.on("GPUMarketLiquidity:InventoryPulled", async ({ event, context }) => {
  const keys = eventKeys(event, context.chain.id);
  const { gpuId, token, amount, isGusd } = event.args;
  // token is the pulled currency's address; isGusd is the authoritative flag.
  void token;
  const asset = await requireAsset(
    context,
    keys.chainId,
    gpuId,
    "InventoryPulled",
  );
  await context.db.update(gpuAssets, { chainId: keys.chainId, gpuId }).set(
    isGusd ? { polGusd: asset.polGusd - amount } : { polGpu: asset.polGpu - amount },
  );
});
