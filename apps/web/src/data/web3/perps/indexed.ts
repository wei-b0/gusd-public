/**
 * Indexed perp reads — the portfolio panel's window into the indexer's
 * projected perp book. Same discipline as the indexer client and the
 * port's indexed-order fetch: inert (null) when NEXT_PUBLIC_INDEXER_URL is
 * absent; any failure — unreachable, slow, malformed — resolves to null,
 * because indexing lag is never an error state. The perps desk reads live
 * chain probes instead; this file is only for the portfolio's history.
 */

import { GPU_ID_TO_ASSET } from "@/data/oracle/panel-map";
import type { AssetId, PerpSide } from "@/domain/types";
import { unscalePrice } from "./math";

export interface IndexedPerpPosition {
  asset: AssetId;
  side: PerpSide;
  /** gUSD product units; 0 marks a closed/liquidated row. */
  sizeUsd: number;
  collateral: number;
  /** USD per GPU-hour product units. */
  entryPrice: number;
  openedAtSec: number | null;
  closedAtSec: number | null;
  liquidatedAtSec: number | null;
  /** Realized PnL across the position's touches, gUSD product units —
   *  null when the indexer hasn't projected it yet. */
  realizedPnl: number | null;
}

/** The oracle proxy's perp-positions endpoint for one wallet. */
export async function fetchIndexedPerpPositions(
  address: string,
): Promise<readonly IndexedPerpPosition[] | null> {
  const url = process.env.NEXT_PUBLIC_INDEXER_URL?.trim();
  if (!url) return null;
  const params = new URLSearchParams({ address: address.toLowerCase(), limit: "50" });
  try {
    const res = await fetch(`${url}/perp/positions?${params.toString()}`, {
      signal: AbortSignal.timeout(5_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { positions?: unknown };
    if (!Array.isArray(body.positions)) return null;
    const out: IndexedPerpPosition[] = [];
    for (const dto of body.positions as {
      gpuId: string;
      isLong: boolean;
      sizeUsd: string;
      collateral: string;
      entryPrice: string;
      openedAtSec: number | null;
      closedAtSec: number | null;
      liquidatedAtSec: number | null;
      realizedPnlGusd: string | null;
    }[]) {
      const asset = GPU_ID_TO_ASSET.get(dto.gpuId);
      if (!asset) continue;
      out.push({
        asset,
        side: dto.isLong ? "long" : "short",
        sizeUsd: Number(dto.sizeUsd) / 1e6,
        collateral: Number(dto.collateral) / 1e6,
        entryPrice: unscalePrice(BigInt(dto.entryPrice)),
        openedAtSec: dto.openedAtSec,
        closedAtSec: dto.closedAtSec,
        liquidatedAtSec: dto.liquidatedAtSec,
        realizedPnl: dto.realizedPnlGusd === null ? null : Number(dto.realizedPnlGusd) / 1e6,
      });
    }
    return out;
  } catch {
    return null;
  }
}

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