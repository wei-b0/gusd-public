"use client";

/**
 * Portfolio — the connection's whole book, grouped the way the product
 * thinks about capital: market exposure, liquid gUSD, earning sGUSD,
 * protocol roles, and the activity trail. Gated on a connection; balances
 * and actions are the only gated things in the product.
 */

import { useState } from "react";
import Link from "next/link";
import { pairName } from "@/domain/types";
import { fmtClock, fmtFull, fmtGusd, fmtGusdPrecise, fmtNotional, fmtPctSigned, fmtUnits, isFlatPct } from "@/domain/format";
import { useAccount, useActivity, useEarn, useMarkets, useServices } from "@/data/services";
import { TuiPanel } from "@/components/ui/panel";

export default function PortfolioPage() {
  const account = useAccount();
  const { auth } = useServices();
  const [busyLink, setBusyLink] = useState(false);

  if (!account.connected) {
    return (
      <div>
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-rule-strong pb-3">
          <h1 className="disp text-[22px] leading-none text-primary">Portfolio</h1>
          <p className="slug text-dim">Positions, capital, and activity</p>
        </div>
        <TuiPanel title="Portfolio">
          <div className="p-3.5">
            <span className="slug border border-rule-strong px-1.5 py-0.5 text-[9px] text-dim">
              Not connected
            </span>
            <p className="mt-3 max-w-prose text-[12.5px] leading-relaxed text-primary">
              Connect to see your market positions, liquid and earning capital, and trade
              history. Demo capital is provided once connected.
            </p>
            <button
              type="button"
              disabled={busyLink}
              onClick={async () => {
                setBusyLink(true);
                try {
                  await auth.connect();
                } finally {
                  setBusyLink(false);
                }
              }}
              className="rev slug mt-4 px-4 py-2 text-rev-fg transition-opacity disabled:opacity-60"
            >
              {busyLink ? "Connecting…" : "Connect"}
            </button>
          </div>
        </TuiPanel>
      </div>
    );
  }

  return <PortfolioBook />;
}

function PortfolioBook() {
  const account = useAccount();
  const markets = useMarkets();
  const earn = useEarn();
  const activity = useActivity();

  const priceOf = new Map(markets.map((m) => [m.asset.id, m.marketPrice]));
  const rows = account.positions.map((p) => {
    const last = priceOf.get(p.asset) ?? p.avgEntry;
    const value = p.size * last;
    const cost = p.size * p.avgEntry;
    const pnl = value - cost;
    const pnlPct = (last / p.avgEntry - 1) * 100;
    return { p, last, value, pnl, pnlPct };
  });
  const positionsValue = rows.reduce((sum, r) => sum + r.value, 0);
  const sGUsdValue = account.sGUsdBalance * earn.rate;
  const total = account.gUsdBalance + sGUsdValue + positionsValue;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-rule-strong pb-3">
        <h1 className="disp text-[22px] leading-none text-primary">Portfolio</h1>
        <p className="slug text-dim">{account.label} · demo capital</p>
      </div>

      {/* Portfolio value — exposure + liquid + earning, one read */}
      <TuiPanel title="Portfolio value" meta="marked to the live market">
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 px-3.5 py-3.5">
          <p className="disp text-[28px] leading-none text-bright">{fmtGusd(total)}</p>
          <p className="num text-[11px] leading-relaxed text-dim">
            Market positions {fmtGusd(positionsValue)} · gUSD {fmtFull(account.gUsdBalance)} · sGUSD{" "}
            {fmtGusd(sGUsdValue)}
          </p>
        </div>
      </TuiPanel>

      {/* 01 — GPU market positions */}
      <div className="mt-5">
        <TuiPanel no="01" title="GPU market positions" meta={`${rows.length} markets`}>
          {rows.length === 0 ? (
            <p className="p-3.5 text-[11.5px] leading-relaxed text-dim">
              No market positions yet. Orders on{" "}
              <Link href="/markets" className="text-data underline decoration-rule-strong underline-offset-2 hover:text-bright">
                Markets
              </Link>{" "}
              or the{" "}
              <Link href="/terminal" className="text-data underline decoration-rule-strong underline-offset-2 hover:text-bright">
                Terminal
              </Link>{" "}
              print here.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr className="border-b border-rule text-left">
                    <th scope="col" className="slug py-2 pl-3.5 pr-4 font-normal text-dim">Market</th>
                    <th scope="col" className="slug px-2.5 py-2 text-right font-normal text-dim">Size</th>
                    <th scope="col" className="slug px-2.5 py-2 text-right font-normal text-dim">
                      Avg entry <span className="tracking-normal normal-case">/ gUSD</span>
                    </th>
                    <th scope="col" className="slug px-2.5 py-2 text-right font-normal text-dim">
                      Market Price <span className="tracking-normal normal-case">/ gUSD</span>
                    </th>
                    <th scope="col" className="slug px-2.5 py-2 text-right font-normal text-dim">Value</th>
                    <th scope="col" className="slug py-2 pr-3.5 text-right font-normal text-dim">
                      P&amp;L <span className="tracking-normal normal-case">/ gUSD</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ p, last, value, pnl, pnlPct }) => {
                    const flat = isFlatPct(pnlPct);
                    return (
                      <tr key={p.asset} className="border-b border-rule last:border-b-0">
                        <td className="py-2.5 pl-3.5 pr-4">
                          <Link
                            href={`/markets/${p.asset}`}
                            className="num text-[13px] font-bold text-data transition-colors hover:text-bright"
                          >
                            {pairName(p.asset)}
                          </Link>
                        </td>
                        <td className="num px-2.5 py-2.5 text-right text-data">{fmtUnits(p.size)}</td>
                        <td className="num px-2.5 py-2.5 text-right text-data">{fmtGusdPrecise(p.avgEntry)}</td>
                        <td className="num px-2.5 py-2.5 text-right text-data">{fmtGusdPrecise(last)}</td>
                        <td className="num px-2.5 py-2.5 text-right text-bright">{fmtGusd(value)}</td>
                        <td
                          className={`num py-2.5 pr-3.5 text-right whitespace-nowrap ${
                            flat ? "text-dim" : pnl >= 0 ? "text-up" : "text-down"
                          }`}
                        >
                          {!flat && (
                            <span aria-hidden className="mr-1 text-[8px]">
                              {pnl >= 0 ? "▲" : "▼"}
                            </span>
                          )}
                          {fmtNotional(Math.abs(pnl))} · {fmtPctSigned(pnlPct)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </TuiPanel>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* Capital — liquid, earning, protocol */}
        <div className="space-y-5">
          <TuiPanel no="02" title="Liquid capital · gUSD" meta="settlement unit">
            <dl className="border-t border-rule">
              <Line label="gUSD balance" value={fmtFull(account.gUsdBalance)} />
              <Line label="Trade with gUSD" value="Markets ▸" href="/markets" />
              <Line label="Mint gUSD" value="gUSD section ▸" href="/gusd" />
            </dl>
          </TuiPanel>

          <TuiPanel no="03" title="Earning capital · sGUSD" meta="gUSD deployed">
            <dl className="border-t border-rule">
              <Line label="sGUSD balance" value={`${fmtFull(account.sGUsdBalance)} sGUSD`} />
              <Line label="Value at rate" value={fmtGusd(sGUsdValue)} />
              <Line label="Trailing 30d APY" value={`${earn.trailingApyPct.toFixed(2)}%`} />
              <Line label="Stake and unstake" value="gUSD section ▸" href="/gusd" />
            </dl>
          </TuiPanel>

          <TuiPanel no="04" title="Protocol positions" meta="lp · borrowing · staking">
            <p className="p-3.5 text-[11.5px] leading-relaxed text-dim">
              No protocol positions yet. Liquidity provision, borrowed exposure, and other
              protocol roles appear here as they launch.
            </p>
          </TuiPanel>
        </div>

        {/* 05 — activity */}
        <TuiPanel no="05" title="Activity" meta={`${activity.length} fills · in gUSD · newest first`}>
          {activity.length === 0 ? (
            <p className="p-3.5 text-[11.5px] leading-relaxed text-dim">
              No fills yet. Executed orders print here newest first.
            </p>
          ) : (
            <div className="border-t border-rule">
              {[...activity].reverse().map((r, i) => {
                const buy = r.side === "buy";
                return (
                  <div
                    key={`${r.t}-${i}`}
                    className="flex flex-wrap items-baseline gap-x-3 border-b border-rule px-3.5 py-2 last:border-b-0"
                  >
                    <span className="num w-14 shrink-0 text-[11px] text-dim">{fmtClock(r.t)}</span>
                    <span className="num w-24 shrink-0 whitespace-nowrap text-[12.5px] font-bold text-data">{pairName(r.asset)}</span>
                    <span className={`slug w-16 shrink-0 ${buy ? "text-up" : "text-down"}`}>
                      <span aria-hidden className="mr-1 text-[8px]">{buy ? "▲" : "▼"}</span>
                      {buy ? "Bought" : "Sold"}
                    </span>
                    <span className="num flex-1 whitespace-nowrap text-right text-[12.5px] text-data">
                      {fmtUnits(r.size)} @ {fmtGusdPrecise(r.fillPrice)}
                    </span>
                    <span className="num w-24 shrink-0 text-right text-[11.5px] text-dim">
                      {fmtNotional(r.notional)} · fee {fmtNotional(r.feeUsd)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </TuiPanel>
      </div>
    </div>
  );
}

function Line({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-rule px-3.5 py-2.5 last:border-b-0">
      <dt className="slug text-dim">
        {href ? (
          <Link href={href} className="transition-colors hover:text-amber">
            {label} ▸
          </Link>
        ) : (
          label
        )}
      </dt>
      <dd className="num whitespace-nowrap text-[12.5px] text-data">{value}</dd>
    </div>
  );
}
