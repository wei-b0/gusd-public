"use client";

/**
 * Portfolio capital panels — liquid gUSD and earning sgUSD as the `dl`
 * ledger rows the product thinks in ("GPU assets → positions, gUSD →
 * available capital, sgUSD → earning capital"). Moved verbatim from the
 * portfolio page; the `Line` helper is the shared row grammar.
 */

import Link from "next/link";
import { fmtFull, fmtGusd, fmtGusdPrecise, fmtNotional, fmtUnitsMax } from "@/domain/format";
import { TuiPanel } from "@/components/ui/panel";
import type { WalletVaultPositionDto } from "@/data/protocol/dto";
import { basisFromVault } from "@/data/protocol/map";

/** The shared ledger row: slug label left, tabular figure right; the
 *  whole row navigates when a destination exists. */
export function Line({ label, value, href, title }: {
  label: string;
  value: string;
  href?: string;
  title?: string;
}) {
  const shell =
    "flex items-baseline justify-between gap-2 border-b border-rule px-3.5 py-2.5 last:border-b-0";
  if (href) {
    // The whole row navigates — the label carries the amber hover voice
    // and the figure rides the same link.
    return (
      <Link href={href} className={`group ${shell} transition-colors`}>
        <dt className="slug text-dim transition-colors group-hover:text-amber">{label} ▸</dt>
        <dd className="num whitespace-nowrap text-[12.5px] text-data" title={title}>
          {value}
        </dd>
      </Link>
    );
  }
  return (
    <div className={shell}>
      <dt className="slug text-dim">{label}</dt>
      <dd className="num whitespace-nowrap text-[12.5px] text-data" title={title}>
        {value}
      </dd>
    </div>
  );
}

/** 04 — liquid capital: gUSD at hand, the settlement unit every trade
 *  prices against. The whole rows navigate. */
export function LiquidPanel({ gUsdBalance, no }: {
  gUsdBalance: number;
  no: string;
}) {
  return (
    <TuiPanel no={no} title="Liquid capital · gUSD" meta="settlement unit">
      <dl className="border-t border-rule">
        <Line label="gUSD balance" value={fmtFull(gUsdBalance)} />
        <Line label="Trade with gUSD" value="Terminal ▸" href="/spot" />
        <Line label="Mint gUSD" value="gUSD section ▸" href="/gusd" />
      </dl>
    </TuiPanel>
  );
}

/** 05 — earning capital: sgUSD shares and what they're worth at the live
 *  vault rate, with basis honesty — a figure the gates can't complete
 *  prints "—" with the gate reason on hover, never a guess. */
export function EarningPanel({ sGUsdBalance, sGUsdValue, vaultPosition, no }: {
  sGUsdBalance: number;
  sGUsdValue: number;
  vaultPosition: WalletVaultPositionDto | null;
  no: string;
}) {
  const basis = vaultPosition === null ? null : basisFromVault(vaultPosition);
  return (
    <TuiPanel no={no} title="Earning capital · sgUSD" meta="gUSD deployed">
      <dl className="border-t border-rule">
        <Line label="sgUSD balance" value={`${fmtUnitsMax(sGUsdBalance)} sgUSD`} />
        <Line label="Value at rate" value={fmtGusd(sGUsdValue)} />
        {basis === null || basis.avgEntry === null ? (
          <Line label="Avg entry" value="—" title={basis?.basisReason ?? undefined} />
        ) : (
          <Line
            label="Avg entry"
            value={`${fmtGusdPrecise(basis.avgEntry)} gUSD / sgUSD`}
          />
        )}
        {basis?.realizedPnl !== null && basis !== null && (
          <Line
            label="Realized"
            value={`${basis.realizedPnl < 0 ? "−" : "+"}${fmtNotional(Math.abs(basis.realizedPnl))} gUSD`}
          />
        )}
        <Line label="Stake and unstake" value="gUSD section ▸" href="/gusd" />
      </dl>
    </TuiPanel>
  );
}
