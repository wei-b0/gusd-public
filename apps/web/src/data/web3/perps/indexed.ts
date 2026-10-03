/**
 * Indexed perp reads — the claimable fallback and the liquidations tape.
 * Same discipline as the indexer client and the port's indexed-order fetch:
 * inert (null) when NEXT_PUBLIC_INDEXER_URL is absent; any failure —
 * unreachable, slow, malformed — resolves to null, because indexing lag is
 * never an error state. Positions are NOT read here: the portfolio probes
 * the chain directly (use-perp-portfolio); the indexer's perp projections
 * never re-mark anything.
 */

import { assetForWireGpuId } from "@/data/web3/gpu-id";
import type { AssetId, PerpSide } from "@/domain/types";
import { unscalePrice } from "./math";

/** The wallet's settled claimable counter as the indexer projected it —
 *  the display figure; the claim action itself re-reads the chain. Null
 *  when the indexer is absent (or the wallet has no settlement row). */
export async function fetchIndexedPerpClaimable(address: string): Promise<number | null> {
  const url = process.env.NEXT_PUBLIC_INDEXER_URL?.trim();
  if (!url) return null;
  const params = new URLSearchParams({ address: address.toLowerCase() });
  try {
    const res = await fetch(`${url}/perp/claimable?${params.toString()}`, {
      signal: AbortSignal.timeout(5_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { claimable?: { balance?: string } | null };
    if (body.claimable === null || body.claimable === undefined) return null;
    return Number(body.claimable.balance) / 1e6;
  } catch {
    return null;
  }
}

/** One row of the liquidations tape — the public record of forced closes
 *  the keeper (or anyone) printed against a past report. */
export interface IndexedPerpLiquidation {
  asset: AssetId;
  side: PerpSide;
  account: string;
  /** USD per GPU-hour product units. */
  execPrice: number;
  /** gUSD product units. */
  liquidationFee: number;
  badDebt: number;
  blockTimestamp: number;
}

/** The liquidations tape as the indexer projected it — newest first is the
 *  API's order; the perps desk's tape band reads it. Null when the indexer
 *  is absent (the band then renders nothing — no indexer, no tape). */
export async function fetchIndexedPerpLiquidations(gpuId?: string): Promise<readonly IndexedPerpLiquidation[] | null> {
  const url = process.env.NEXT_PUBLIC_INDEXER_URL?.trim();
  if (!url) return null;
  const params = new URLSearchParams({ limit: "20" });
  if (gpuId) params.set("gpu", gpuId);
  try {
    const res = await fetch(`${url}/perp/liquidations?${params.toString()}`, {
      signal: AbortSignal.timeout(5_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { liquidations?: unknown };
    if (!Array.isArray(body.liquidations)) return null;
    const out: IndexedPerpLiquidation[] = [];
    for (const dto of body.liquidations as {
      gpuId: string;
      isLong: boolean;
      account: string;
      execPrice: string;
      liquidationFee: string;
      badDebt: string;
      blockTimestamp: number;
    }[]) {
      const asset = assetForWireGpuId(dto.gpuId);
      // Unmapped SKUs have no desk to read the row on — skip, don't invent.
      if (!asset) continue;
      out.push({
        asset,
        side: dto.isLong ? "long" : "short",
        account: dto.account,
        execPrice: unscalePrice(BigInt(dto.execPrice)),
        liquidationFee: Number(dto.liquidationFee) / 1e6,
        badDebt: Number(dto.badDebt) / 1e6,
        blockTimestamp: dto.blockTimestamp,
      });
    }
    return out;
  } catch {
    return null;
  }
}