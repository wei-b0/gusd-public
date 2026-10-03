import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { pairName, parseAssetId } from "@/domain/types";
import { SpotDesk } from "@/components/spot/spot-desk";

interface Props {
  params: Promise<{ asset: string }>;
  searchParams: Promise<{ side?: string | string[] }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { asset } = await params;
  const id = parseAssetId(asset);
  return { title: id ? `${id} Spot — gUSD` : "Spot — gUSD" };
}

/** The spot desk, pre-bound to one market. The discovery board stays the
 *  parent: the breadcrumb reads [Markets] / pair, the way the folded market
 *  detail page oriented its depth. Leveraged exposure trades on the perps
 *  desk, one click deeper on the same market. */
export default async function SpotAssetPage({ params, searchParams }: Props) {
  const { asset } = await params;
  // ?side=sell lands the desk with the slip already on the sell side —
  // strict validation: anything but a literal "sell"/"buy" (including an
  // array value) falls through to the desk's own buy default.
  const { side } = await searchParams;
  const initialSide = side === "sell" ? "sell" : side === "buy" ? "buy" : null;
  const assetId = parseAssetId(asset);
  if (!assetId) notFound();
  return (
    <div>
      <nav aria-label="Breadcrumb" className="flex items-baseline gap-2">
        <Link href="/" className="slug text-dim transition-colors hover:text-amber">
          [Markets]
        </Link>
        <span aria-hidden className="text-deep">/</span>
        <span aria-current="page" className="num text-[12px] text-data">{pairName(assetId)}</span>
      </nav>
      <div className="mb-4 mt-4 flex items-baseline justify-between gap-3 border-b border-rule-strong pb-3">
        <h1 className="disp text-[22px] leading-none text-primary">Spot</h1>
        <p className="slug text-dim">Spot desk · analyse and execute</p>
      </div>
      <SpotDesk asset={assetId} initialSide={initialSide ?? undefined} />
    </div>
  );
}