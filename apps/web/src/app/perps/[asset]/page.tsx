import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { pairName, parseAssetId } from "@/domain/types";
import { PerpsDesk } from "@/components/perps/perps-desk";

interface Props {
  params: Promise<{ asset: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { asset } = await params;
  const id = parseAssetId(asset);
  return { title: id ? `${id} Perps — gUSD` : "Perps — gUSD" };
}

/** The perpetuals desk, pre-bound to one market. Positions are gUSD-settled
 *  leveraged exposure to the same oracle reports the spot desk trades — no
 *  GPU tokens move; the sgUSD vault is the counterparty capital. */
export default async function PerpsAssetPage({ params }: Props) {
  const { asset } = await params;
  const assetId = parseAssetId(asset);
  if (!assetId) notFound();
  return (
    <div>
      <nav aria-label="Breadcrumb" className="flex items-baseline gap-2">
        <Link href="/" className="slug text-dim transition-colors hover:text-amber">
          [Markets]
        </Link>
        <span aria-hidden className="text-deep">/</span>
        <Link
          href={`/spot/${assetId}`}
          className="slug text-dim transition-colors hover:text-amber"
        >
          {pairName(assetId)}
        </Link>
        <span aria-hidden className="text-deep">/</span>
        <span aria-current="page" className="num text-[12px] text-data">perp</span>
      </nav>
      <div className="mb-4 mt-4 flex items-baseline justify-between gap-3 border-b border-rule-strong pb-3">
        <h1 className="disp text-[22px] leading-none text-primary">Perps</h1>
        <p className="slug text-dim">gUSD-settled perpetual futures · keeper executed</p>
      </div>
      <PerpsDesk asset={assetId} />
    </div>
  );
}