import type { Metadata } from "next";
import Link from "next/link";
import { TuiPanel } from "@/components/ui/panel";
import { PerpMarketsTable } from "@/components/perps/perp-markets-table";

export const metadata: Metadata = {
  title: "Perps — gUSD",
};

/**
 * Perps — the perpetuals board: the four settlement panels as leveraged,
 * gUSD-settled markets. A row routes to that market's perp desk.
 */
export default function PerpsIndexPage() {
  return (
    <div>
      <div className="mb-4 mt-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-rule-strong pb-3">
        <h1 className="disp text-[22px] leading-none text-primary">Perps</h1>
        <p className="slug text-dim">
          gUSD-settled perpetual futures · fills settle at verified report prices
        </p>
      </div>

      <TuiPanel no="01" title="Markets" meta="leverage · gUSD-settled">
        <PerpMarketsTable />
        <p className="px-3.5 pb-3.5 pt-3 text-[11.5px] leading-relaxed text-dim">
          Open a desk from a row. Position PnL settles in gUSD — no GPU tokens move. Need the
          underlying instead?{" "}
          <Link
            href="/"
            className="text-data underline decoration-rule-strong underline-offset-2 hover:text-bright"
          >
            the spot desk
          </Link>{" "}
          trades the GPU tokens outright.
        </p>
      </TuiPanel>
    </div>
  );
}