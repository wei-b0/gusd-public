/**
 * Which asset classes the oracle settles, derived from the same source the
 * oracle itself reads: `SETTLEMENT_PANELS` in @gusd/gpu-catalog. Panel and
 * gpu identifiers are imported, not mirrored — a panel added to the catalog
 * flows here on the next build, so the web's notion of oracle coverage can
 * never drift from the oracle's.
 *
 * The only web-local knowledge is the join below: which catalog SKU each
 * product asset's economics reference (product vocabulary: H100, not
 * H100_SXM_80GB).
 */

import { SETTLEMENT_PANELS, type GpuId } from "@gusd/gpu-catalog";
import type { AssetId } from "@/domain/types";

export interface PanelRef {
  panelId: string;
  gpuId: GpuId;
}

/** Product asset → the catalog SKU its Index settles on. */
const ASSET_GPU: Record<AssetId, GpuId> = {
  A100: "A100_SXM_80GB",
  H100: "H100_SXM_80GB",
  H200: "H200_141GB",
  B200: "B200_192GB",
  B300: "B300_288GB",
  GB200: "GB200_192GB",
  GB300: "GB300_288GB",
};

function buildOraclePanels(): Record<AssetId, PanelRef> {
  const out = {} as Record<AssetId, PanelRef>;
  for (const [asset, gpuId] of Object.entries(ASSET_GPU) as [AssetId, GpuId][]) {
    const panel = SETTLEMENT_PANELS.find((p) => p.gpuId === gpuId);
    if (panel) out[asset] = { panelId: panel.id, gpuId };
  }
  return out;
}

/** Every product asset the oracle settles, keyed by AssetId. An asset with
 *  no settlement panel in the catalog is simply absent — `isOracleBacked`
 *  answers false and the row stays on the mock layer. */
export const ORACLE_PANELS = buildOraclePanels();

export type OracleAssetId = keyof typeof ORACLE_PANELS;

/** gpuId → AssetId, for resolving stream frames and REST rows. */
export const GPU_ID_TO_ASSET: ReadonlyMap<string, AssetId> = new Map(
  Object.entries(ORACLE_PANELS).map(([asset, ref]) => [ref.gpuId, asset as AssetId]),
);

export function isOracleBacked(asset: AssetId): asset is OracleAssetId {
  return asset in ORACLE_PANELS;
}

/** Resolve a REST `:gpu` param (panel id or gpu id) back to an AssetId. */
export function assetForGpuParam(param: string): AssetId | null {
  for (const [asset, ref] of Object.entries(ORACLE_PANELS)) {
    if (ref.panelId === param || ref.gpuId === param) return asset as AssetId;
  }
  return null;
}
