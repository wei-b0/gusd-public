"use client";

/**
 * Portfolio — the wallet's whole book on one surface: spot positions with
 * Trade/Sell controls, perp positions as verified chain probes with
 * one-click closes, armed orders with Cancel, capital, and activity.
 * Gated on a connection; balances and actions are the only gated things
 * in the product.
 */

import { useMemo, useState } from "react";
import { isActionTerminal } from "@/domain/actions";
import { fmtGusd, fmtFull, fmtSignedGusd } from "@/domain/format";
import { useAccount, useActions, useEarn, useMarkets, useServices } from "@/data/services";
import { useWalletActivity } from "@/data/protocol/hooks";
import { mergeActivity } from "@/data/protocol/map";
import { liveRows, portfolioEquity } from "@/data/web3/perps/portfolio-book";
import { usePerpPortfolio } from "@/data/web3/perps/use-perp-portfolio";
import { TuiPanel } from "@/components/ui/panel";
import { spotRows, SpotBook } from "@/components/portfolio/spot-book";
import { PerpBook } from "@/components/portfolio/perp-book";
import { OrdersBook } from "@/components/portfolio/orders-book";
import { EarningPanel, LiquidPanel } from "@/components/portfolio/capital-panels";
import { ActivityPanel } from "@/components/portfolio/activity-feed";

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
              Connect to see your market positions, liquid and earning capital, and this
              session's executed actions.
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
  const actions = useActions();
  const activity = useWalletActivity();

  // One hook instance for the whole page — the perp and orders books share
  // it, so the two can never disagree. Settled actions move the chain
  // counters; each settled receipt re-probes.
  const settledCount = actions.filter((a) => isActionTerminal(a.phase)).length;
  const book = usePerpPortfolio(settledCount);

  // The indexed ledger: the wallet's routed executions + raw protocol
  // events, merged and deduped (a Buy event inside an execution's tx
  // yields to the execution row, which carries the legs).
  const indexedRows = useMemo(
    () => mergeActivity(activity.executions, activity.events, 100),
    [activity.executions, activity.events],
  );
  // Session cards fold away once the indexer reflects their transactions —
  // the indexed row then tells the same story with chain facts. In-flight
  // cards always stay. A terminal card whose tx hasn't been indexed yet
  // keeps "this session" provenance (indexing lag is not a failure).
  const indexedHashes = useMemo(
    () => new Set(indexedRows.map((r) => r.txHash.toLowerCase())),
    [indexedRows],
  );
  const sessionCards = useMemo(
    () =>
      actions.filter((a) => {
        if (!isActionTerminal(a.phase)) return true;
        const hashes = a.steps.flatMap((s) => (s.hash !== null ? [s.hash.toLowerCase()] : []));
        return hashes.length > 0 ? !hashes.some((h) => indexedHashes.has(h)) : true;
      }),
    [actions, indexedHashes],
  );
  const { rows, positionsValue } = useMemo(
    () => spotRows(account.positions, markets),
    [account.positions, markets],
  );
  // The share price is the vault's read; before the first read lands the
  // earning value prints 0 rather than an invented figure.
  const sGUsdValue = account.sGUsdBalance * (earn.rate ?? 0);
  const perpRows = liveRows(book.probes);
  // Headline honesty: perp equity counts only when the book is fully known
  // (no live rows, or every live row marked). A live-but-unmarked book
  // prints `Perps —` — the gap named, never a silent zero, never a figure
  // against an unverified price.
  const equity = portfolioEquity({
    gUsd: account.gUsdBalance,
    sGUsdValue,
    spotValue: positionsValue,
    perpRows,
  });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-rule-strong pb-3">
        <h1 className="disp text-[22px] leading-none text-primary">Portfolio</h1>
        <p className="slug text-dim">{account.label}</p>
      </div>

      {/* Portfolio value — exposure + liquid + earning + perp equity, one read */}
      <TuiPanel title="Portfolio value" meta="marked to the live market">
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 px-3.5 py-3.5">
          <p className="disp text-[26px] leading-none text-bright">{fmtGusd(equity.total)}</p>
          <p className="num text-[11px] leading-relaxed text-dim">
            Market positions {fmtGusd(positionsValue)} · gUSD {fmtFull(account.gUsdBalance)} · sgUSD{" "}
            {fmtGusd(sGUsdValue)}
            {perpRows.length > 0 &&
              (equity.perpEquity === null
                ? " · perps —"
                : ` · perps ${fmtSignedGusd(equity.perpEquity)}`)}
          </p>
        </div>
      </TuiPanel>

      <div className="mt-5">
        <SpotBook rows={rows} no="01" />
      </div>
      <div className="mt-5">
        <PerpBook book={book} no="02" />
      </div>
      <div className="mt-5">
        <OrdersBook book={book} no="03" />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-5">
          <LiquidPanel gUsdBalance={account.gUsdBalance} no="04" />
          <EarningPanel
            sGUsdBalance={account.sGUsdBalance}
            sGUsdValue={sGUsdValue}
            vaultPosition={activity.vaultPosition}
            no="05"
          />
        </div>
        <ActivityPanel
          indexedRows={indexedRows}
          sessionCards={sessionCards}
          hasEarlier={activity.hasMoreExecutions || activity.hasMoreEvents}
          loadEarlier={activity.loadEarlier}
          no="06"
        />
      </div>
    </div>
  );
}
