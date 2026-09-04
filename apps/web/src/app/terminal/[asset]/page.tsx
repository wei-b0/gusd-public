import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { parseAssetId } from "@/domain/types";
import { TerminalDesk } from "@/components/terminal/terminal-desk";

interface Props {
  params: Promise<{ asset: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { asset } = await params;
  const id = parseAssetId(asset);
  return { title: id ? `${id} Terminal — gUSD` : "Terminal — gUSD" };
}

/** The professional desk, pre-bound to one market. */
export default async function TerminalAssetPage({ params }: Props) {
  const { asset } = await params;
  const assetId = parseAssetId(asset);
  if (!assetId) notFound();
  return (
    <div>
      <div className="mb-4 flex items-baseline justify-between gap-3 border-b border-rule-strong pb-3">
        <h1 className="disp text-[22px] leading-none text-primary">Terminal</h1>
        <p className="slug text-dim">Professional desk · analyse and execute</p>
      </div>
      <TerminalDesk initial={assetId} />
    </div>
  );
}
