import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { pairName, parseAssetId } from "@/domain/types";
import { TerminalDesk } from "@/components/terminal/terminal-desk";

interface Props {
  params: Promise<{ asset: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { asset } = await params;
  const id = parseAssetId(asset);
  return { title: id ? `${id} Terminal — gUSD` : "Terminal — gUSD" };
}

/** The professional desk, pre-bound to one market. The discovery board stays
 *  the parent: the breadcrumb reads [Markets] / pair, the way the retired
 *  market detail page oriented its depth. */
export default async function TerminalAssetPage({ params }: Props) {
  const { asset } = await params;
  const assetId = parseAssetId(asset);
  if (!assetId) notFound();
  return (
    <div>
      <nav aria-label="Breadcrumb" className="flex items-baseline gap-2">
        <Link href="/markets" className="slug text-dim transition-colors hover:text-amber">
          [Markets]
        </Link>
        <span aria-hidden className="text-deep">/</span>
        <span aria-current="page" className="num text-[12px] text-data">{pairName(assetId)}</span>
      </nav>
      <div className="mb-4 mt-4 flex items-baseline justify-between gap-3 border-b border-rule-strong pb-3">
        <h1 className="disp text-[22px] leading-none text-primary">Terminal</h1>
        <p className="slug text-dim">Professional desk · analyse and execute</p>
      </div>
      <TerminalDesk asset={assetId} />
    </div>
  );
}
