"use client";

/**
 * The Protocol page's Markets & pools table. Without the indexer it renders
 * the page's static roster verbatim (mock mode, CI, server render); with it,
 * LIVE/PLANNED comes from the indexed pool roster (a canonical pool row =
 * live) and each row gains its real swap count and lifetime swap volume
 * (the indexer's cumulative volumeGusd, not a windowed figure). Volume here
 * is pool flow only: hook fees and router-only issuance legs never count
 * (pool volume doctrine).
 */

import Link from "next/link";
import { ASSET_IDS, type AssetId } from "@/domain/types";
import { assetForGpuId } from "@/data/web3/gpu-id";
import { useProtocolPools } from "@/data/protocol/hooks";
import type { PoolDto } from "@/data/protocol/dto";

const CLASSES = ASSET_IDS;
type Cls = AssetId;

function volumeOf(pool: PoolDto): number | null {
  try {
    return Number(BigInt(pool.volumeGusd)) / 1e6;
  } catch {
    return null;
  }
}

export function ProtocolPoolsTable() {
  const pools = useProtocolPools();

  // Canonical pool per product asset — one pool per GPU class.
  const poolByAsset = new Map<Cls, PoolDto>();
  for (const pool of Object.values(pools)) {
    if (!pool.canonical || pool.gpuId === null) continue;
    const asset = assetForGpuId(pool.gpuId as `0x${string}`);
    if (asset !== null && (CLASSES as readonly string[]).includes(asset)) {
      poolByAsset.set(asset, pool);
    }
  }
  const indexed = poolByAsset.size > 0;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-rule-strong text-left">
            <th scope="col" className="slug py-2 pl-3.5 pr-4 text-dim">Pair</th>
            <th scope="col" className="slug px-2.5 py-2 text-dim">Venue</th>
            <th scope="col" className="slug px-2.5 py-2 text-dim">Hook</th>
            {indexed && (
              <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Swaps</th>
            )}
            {indexed && (
              <th scope="col" className="slug px-2.5 py-2 text-right text-dim">
                Volume <span className="tracking-normal normal-case">/ gUSD</span>
              </th>
            )}
            <th scope="col" className="slug py-2 pr-3.5 text-right text-dim">Status</th>
          </tr>
        </thead>
        <tbody>
          {CLASSES.map((id) => {
            const pool = poolByAsset.get(id);
            const live = indexed ? pool !== undefined : id === "H100";
            const volume = pool === undefined ? null : volumeOf(pool);
            return (
              <tr key={id} className="border-b border-rule last:border-b-0">
                <td className="py-2.5 pl-3.5 pr-4">
                  <Link
                    href={`/terminal/${id}`}
                    className="num text-[13px] font-bold text-data transition-colors hover:text-bright"
                  >
                    {id} / gUSD
                  </Link>
                </td>
                <td className="px-2.5 py-2.5 text-[12px] text-data">Uniswap v4</td>
                <td className="px-2.5 py-2.5 text-[12px] text-data">gUSD hook</td>
                {indexed && (
                  <td className="px-2.5 py-2.5 text-right text-[12px] text-data">
                    {pool === undefined ? "—" : pool.swapCount}
                  </td>
                )}
                {indexed && (
                  <td className="px-2.5 py-2.5 text-right text-[12px] text-data">
                    {volume === null ? "—" : volume.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                  </td>
                )}
                <td className="py-2.5 pr-3.5 text-right">
                  <span
                    className={`slug border px-1.5 py-0.5 text-[8.5px] ${
                      live ? "border-up text-up" : "border-rule-strong text-dim"
                    }`}
                  >
                    {live ? "LIVE" : "PLANNED"}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
