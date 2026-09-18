import type { Metadata } from "next";
import { TuiPanel } from "@/components/ui/panel";
import { ProtocolPoolsTable } from "@/components/protocol/protocol-pools-table";

export const metadata: Metadata = {
  title: "Protocol — gUSD",
};

/**
 * Protocol — the architecture page: how GPU pricing sources become the
 * Index, how the Index wires into Uniswap v4 through gUSD hooks, and the
 * standing principles. Only resolved mechanics; nothing invented.
 */

export default function ProtocolPage() {
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-rule-strong pb-3">
        <h1 className="disp text-[22px] leading-none text-primary">Protocol</h1>
        <p className="slug text-dim">Architecture · resolved mechanics only</p>
      </div>

      {/* 01 — architecture */}
      <TuiPanel no="01" title="Architecture" meta="how the Index reaches the market">
        <pre aria-label="Protocol architecture diagram" className="num overflow-x-auto border-t border-rule p-3.5 text-[10.5px] leading-[1.7] text-data">
{`  GPU PRICING SOURCES
  provider observations, USD per GPU-hour
              │
              ▼
      ORACLE · INDEX  ───  gUSD DATA
      weighted reference     published series
              │
              ▼
        gUSD HOOKS  ·  Uniswap v4
        permissioned logic on every swap
              │
              ▼
     gUSD MARKETS  ·  4 GPU classes
     market price ⇄ reference = basis`}
        </pre>
        <p className="px-3.5 pb-3.5 text-[11.5px] leading-relaxed text-dim">
          Provider observations feed the Index; the Index publishes per epoch; gUSD hooks
          carry that reference into Uniswap v4 pools so every GPU market trades against a
          live Index reference.
        </p>
      </TuiPanel>

      {/* 02 — markets & pools */}
      <div className="mt-5">
        <TuiPanel no="02" title="Markets & pools" meta="one pool per GPU class">
          <ProtocolPoolsTable />
          <p className="px-3.5 pb-3.5 pt-3 text-[11.5px] leading-relaxed text-dim">
            Each GPU class is its own pool against gUSD — no basket, no shared curve. The
            pools execute onchain: H100 is deployed and trading from primary issuance
            today, and the rest of the catalog deploys with the rollout.
          </p>
        </TuiPanel>
      </div>

      {/* 03 — the hook */}
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <TuiPanel no="03" title="The hook" meta="why v4">
          <div className="space-y-3 border-t border-rule p-3.5 text-[12px] leading-relaxed text-data">
            <p>
              Uniswap v4 pools run their logic through hooks — code attached to the pool
              that participates in every swap. gUSD uses that seam to keep each GPU market
              anchored to the Index rather than drifting as a standalone AMM.
            </p>
            <p>
              The hook is the difference between a pool that merely prices GPU-hours and a
              market that quotes them against a published reference. The basis — the gap
              between the two — is the product's central read.
            </p>
            <p className="text-dim">
              Hook parameters finalize with the protocol contracts; this page describes the
              resolved shape, not implementation detail.
            </p>
          </div>
        </TuiPanel>

        {/* 04 — principles */}
        <TuiPanel no="04" title="Principles" meta="standing design decisions">
          <ul className="space-y-3 border-t border-rule p-3.5 text-[12px] leading-relaxed text-data">
            <li className="border-b border-rule pb-3">
              <span className="slug block text-amber">Not a standalone AMM</span>
              Every market is anchored to the Index through the hook; pricing is a dialogue
              between flow and reference, never an island.
            </li>
            <li className="border-b border-rule pb-3">
              <span className="slug block text-amber">Not CDP-based</span>
              gUSD is not minted against over-collateralized debt positions. Issuance and
              the markets it settles follow the compute economy directly.
            </li>
            <li className="border-b border-rule pb-3">
              <span className="slug block text-amber">Issuance follows demand</span>
              Supply responds to the GPU markets themselves — compute demand sets the shape,
              not a governance dial.
            </li>
            <li>
              <span className="slug block text-amber">LPs are central</span>
              Liquidity providers are the protocol's counterparties and first citizens;
              the products around earning and minting exist for them.
            </li>
          </ul>
        </TuiPanel>
      </div>
    </div>
  );
}
