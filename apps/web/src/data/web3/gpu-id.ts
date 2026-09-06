/**
 * gpuId encoding — the bridge between the product's AssetId vocabulary and
 * the contracts' bytes32 keys. Onchain a gpuId is the catalog SKU left-
 * aligned into bytes32 with zero padding (apps/contracts/src/libraries/
 * GpuId.sol), so "H100_SXM_80GB" ↔ 0x483130305f53584d5f3830474200…00. The
 * mapping is bijective; the reverse decodes event logs back to product
 * assets.
 */

import { padHex, toHex, type Hex } from "viem";
import type { AssetId } from "@/domain/types";
import { ORACLE_PANELS } from "@/data/oracle/panel-map";

/** bytes32 key for an AssetId's settlement SKU. The contract form is
 *  `bytes32(bytes(sku))` — ASCII first, zero padding after. */
export function gpuIdForAsset(asset: AssetId): Hex {
  const ref = ORACLE_PANELS[asset];
  if (!ref) {
    throw new Error(`${asset} has no oracle settlement panel — no market settles on it.`);
  }
  return padHex(toHex(ref.gpuId), { size: 32, dir: "right" });
}

/** Reverse decode: bytes32 → catalog SKU string. Padding is trailing zero
 *  bytes and SKUs are printable ASCII, so stripping whole trailing 00 pairs
 *  never eats a real character. */
export function gpuIdToString(gpuId: Hex): string {
  const raw = gpuId.slice(2).replace(/(00)+$/, "");
  return (raw.match(/.{2}/g) ?? [])
    .map((b) => String.fromCharCode(Number.parseInt(b, 16)))
    .join("");
}

/** bytes32 → the product AssetId it settles, or null when unregistered. */
export function assetForGpuId(gpuId: Hex): AssetId | null {
  const sku = gpuIdToString(gpuId);
  for (const [asset, ref] of Object.entries(ORACLE_PANELS)) {
    if (ref.gpuId === sku) return asset as AssetId;
  }
  return null;
}
