"use client";

/**
 * The front door: straight to Markets. Discovery first — what exists, what
 * it trades at, and where the Index stands — with no execution on this page.
 * The live announcement rides beneath the title, oversized: a hero-grade
 * system strip, not a marketing ribbon.
 */

import Link from "next/link";
import { MarketsDiscovery } from "@/components/markets/discovery";
import { TuiPanel } from "@/components/ui/panel";

export default function HomePage() {
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-rule-strong pb-3">
        <h1 className="disp text-[22px] leading-none text-primary">Markets</h1>
      </div>

      <div className="mb-5 border border-rule-strong bg-panel">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
          <div>
            <p className="slug flex items-center gap-2.5 text-dim">
              <span
                aria-hidden
                className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-bright"
              />
              <span className="text-[15px] tracking-wide text-bright">LIVE ON MAINNET</span>
              <span aria-hidden className="mx-1 text-deep">
                ///
              </span>
              <span className="text-[13px]">gUSD settles on Robinhood Chain</span>
            </p>
            <p className="slug mt-1 flex items-baseline gap-2 text-dim">
              <span className="text-[15px] tracking-wide text-bright">
                EARN UP TO 8% APY<span aria-hidden>*</span>
              </span>
              <span aria-hidden className="mx-1 text-deep">
                ///
              </span>
              <span className="text-[13px]">deposit gUSD into the sgUSD vault</span>
              <span className="text-[12px] text-deep">* experimental</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-5">
            <Link href="/gusd" className="slug text-[13px] text-amber transition-colors hover:text-bright">
              Earn &gt;
            </Link>
            <Link
              href="/terminal/H100"
              className="slug text-[13px] text-amber transition-colors hover:text-bright"
            >
              Trade &gt;
            </Link>
          </div>
        </div>
      </div>

      <MarketsDiscovery />

      {/* 03 — the roadmap: where the protocol stands and where it goes next.
          Status chips reuse the receipt grammar (rev = live, amber border =
          in build, dim borders beyond). Grouped in order: live, in build,
          next, later. */}
      <div className="mt-5">
        <TuiPanel no="03" title="Protocol roadmap" meta="mainnet era">
          <ul className="divide-y divide-rule">
            <RoadmapRow
              status="live"
              title="GPU asset markets on mainnet"
              detail="H100, H200, L40S, and RTX 4090 trade against the gUSD Index, settled on Robinhood Chain."
            />
            <RoadmapRow
              status="live"
              title="Cross-chain funding"
              detail="Fund the desk from Ethereum, Base, or Arbitrum One over Across rails — gUSD mints on arrival."
            />
            <RoadmapRow
              status="live"
              title="GPU Index API / Oracle infrastructure"
              detail="Benchmark prices published onchain by the oracle network; the full index series open over the API."
            />
            <RoadmapRow
              status="build"
              title="sgUSD protocol liquidity"
              detail="Deposit gUSD, hold sgUSD, earn from market activity. Experimental — the share price is the yield."
            />
            <RoadmapRow
              status="next"
              title="GPU perpetual markets"
              detail="Levered exposure to GPU compute rates, settled in gUSD against the same index benchmarks."
            />
            <RoadmapRow
              status="next"
              title="Institutional hedging tools"
              detail="Position-level hedges for operators holding GPU inventory across rental cycles."
            />
            <RoadmapRow
              status="later"
              title="Permissionless GPU markets"
              detail="Anyone lists a GPU SKU; the oracle prices it and the market opens without protocol sign-off."
            />
            <RoadmapRow
              status="later"
              title="Multi-chain GPU markets"
              detail="The same desks and benchmarks on additional chains — one protocol, many settlement homes."
            />
          </ul>
        </TuiPanel>
      </div>
    </div>
  );
}

const STATUS_STYLE: Record<RoadmapStatus, { chip: string; label: string }> = {
  live: { chip: "rev slug inline-block px-1.5 py-0.5 text-[9.5px]", label: "LIVE" },
  build: {
    chip: "slug inline-block border border-amber/40 px-1.5 py-0.5 text-[9.5px] text-amber",
    label: "IN BUILD",
  },
  next: {
    chip: "slug inline-block border border-rule-strong px-1.5 py-0.5 text-[9.5px] text-dim",
    label: "NEXT",
  },
  later: {
    chip: "slug inline-block border border-rule px-1.5 py-0.5 text-[9.5px] text-deep",
    label: "LATER",
  },
};

type RoadmapStatus = "live" | "build" | "next" | "later";

function RoadmapRow({
  status,
  title,
  detail,
}: {
  status: RoadmapStatus;
  title: string;
  detail: string;
}) {
  const s = STATUS_STYLE[status];
  return (
    <li className="flex items-baseline gap-3 py-2.5 first:pt-0 last:pb-0">
      <span className={`w-20 shrink-0 text-center ${s.chip}`}>{s.label}</span>
      <div className="min-w-0">
        <p className="text-[13px] leading-snug text-data">{title}</p>
        <p className="mt-0.5 max-w-prose text-[11.5px] leading-relaxed text-dim">{detail}</p>
      </div>
    </li>
  );
}
