"use client";

/**
 * Portfolio — the connection's whole book, grouped the way the product
 * thinks about capital: market exposure, liquid gUSD, earning sgUSD,
 * protocol roles, and the activity trail. Gated on a connection; balances
 * and actions are the only gated things in the product.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { pairName } from "@/domain/types";
import { fmtClock, fmtFull, fmtGusd, fmtGusdPrecise, fmtNotional, fmtPctSigned, fmtSignedGusd, fmtUnits, fmtUnitsMax, isFlatPct } from "@/domain/format";
import { isActionTerminal, type ActionRecord } from "@/domain/actions";
import { useAccount, useActiveAction, useActions, useEarn, useMarkets, useServices, useWalletSession } from "@/data/services";
import { useWalletActivity } from "@/data/protocol/hooks";
import {
  basisFromVault,
  mergeActivity,
  type ActivityRow,
} from "@/data/protocol/map";
import { fetchIndexedPerpClaimable, fetchIndexedPerpPositions, type IndexedPerpPosition } from "@/data/web3/perps/indexed";
import { pnl } from "@/data/web3/perps/math";
import { ActionStatus, PhaseTag } from "@/components/ui/action-status";
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
  const recordHashes = (a: ActionRecord): string[] =>
    a.steps.flatMap((s) => (s.hash !== null ? [s.hash.toLowerCase()] : []));
  const sessionCards = actions.filter((a) => {
    if (!isActionTerminal(a.phase)) return true;
    const hashes = recordHashes(a);
    return hashes.length > 0
      ? !hashes.some((h) => indexedHashes.has(h))
      : true;
  });
  const hasIndexed = indexedRows.length > 0;
  // The earning layer's cost basis (panel 03) — null fields print "—" until
  // the indexer lands them. (Protocol-level vault aggregates live on the
  // /gusd Earn panel, not in the personal portfolio.)
  const vaultBasis =
    activity.vaultPosition === null ? null : basisFromVault(activity.vaultPosition);

  // Mark to the displayed price: the venue price when a market layer exists,
  // otherwise the API's Index — never a simulated stand-in for either. The
  // unit follows the leg: gUSD per asset unit, or $ per GPU-hour while the
  // benchmark is the market's price.
  const priceOf = new Map(markets.map((m) => [m.asset.id, m.marketPrice ?? m.indexPrice]));
  const unitOf = new Map(markets.map((m) => [m.asset.id, m.marketPrice !== null ? "gUSD" : "/ GPU-hour"]));
  const rows = account.positions.map((p) => {
    // No cost-basis source pre-indexer: avgEntry is null then, and the P&L
    // columns print "—" rather than math against an invented basis. With
    // neither a market price nor a basis, the value itself is unmarkable.
    const last = priceOf.get(p.asset) ?? p.avgEntry;
    const unit = unitOf.get(p.asset) ?? "gUSD";
    const basis = p.avgEntry;
    const value = last === null ? null : p.size * last;
    const cost = basis === null ? null : p.size * basis;
    const pnl = value === null || cost === null ? null : value - cost;
    const pnlPct = last === null || basis === null ? null : (last / basis - 1) * 100;
    return { p, last, unit, value, pnl, pnlPct };
  });
  // The headline sums what can be marked; unmarkable positions print "—"
  // in their row rather than a fabricated 0 in the total.
  const positionsValue = rows.reduce((sum, r) => sum + (r.value ?? 0), 0);
  // The share price is the vault's read; before the first read lands the
  // earning value prints 0 rather than an invented figure.
  const sGUsdValue = account.sGUsdBalance * (earn.rate ?? 0);
  const total = account.gUsdBalance + sGUsdValue + positionsValue;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-rule-strong pb-3">
        <h1 className="disp text-[22px] leading-none text-primary">Portfolio</h1>
        <p className="slug text-dim">{account.label}</p>
      </div>

      {/* Portfolio value — exposure + liquid + earning, one read */}
      <TuiPanel title="Portfolio value" meta="marked to the live market">
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 px-3.5 py-3.5">
          <p className="disp text-[26px] leading-none text-bright">{fmtGusd(total)}</p>
          <p className="num text-[11px] leading-relaxed text-dim">
            Market positions {fmtGusd(positionsValue)} · gUSD {fmtFull(account.gUsdBalance)} · sgUSD{" "}
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
              <Link href="/" className="text-data underline decoration-rule-strong underline-offset-2 hover:text-bright">
                Markets
              </Link>{" "}
              or the{" "}
              <Link href="/spot" className="text-data underline decoration-rule-strong underline-offset-2 hover:text-bright">
                Terminal
              </Link>{" "}
              print here.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr className="border-b border-rule text-left">
                    <th scope="col" className="slug py-2 pl-3.5 pr-4 text-dim">Market</th>
                    <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Size</th>
                    <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Avg entry</th>
                    <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Last price</th>
                    <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Value</th>
                    <th scope="col" className="slug py-2 pr-3.5 text-right text-dim">
                      P&amp;L <span className="tracking-normal normal-case">/ gUSD</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ p, last, unit, value, pnl, pnlPct }) => {
                    const flat = pnlPct === null || isFlatPct(pnlPct);
                    return (
                      <tr key={p.asset} className="border-b border-rule last:border-b-0">
                        <td className="py-2.5 pl-3.5 pr-4">
                          <Link
                            href={`/spot/${p.asset}`}
                            className="num text-[13px] font-bold text-data transition-colors hover:text-bright"
                          >
                            {pairName(p.asset)}
                          </Link>
                        </td>
                        <td className="num px-2.5 py-2.5 text-right text-data">{fmtUnits(p.size)}</td>
                        <td className="num px-2.5 py-2.5 text-right text-data">
                          {p.avgEntry === null ? (
                            <span title={p.basisReason ?? undefined}>—</span>
                          ) : (
                            fmtGusdPrecise(p.avgEntry)
                          )}
                          <span className="ml-1 text-[10px] text-dim">{unit}</span>
                        </td>
                        <td className="num px-2.5 py-2.5 text-right text-data">
                          {last === null ? "—" : fmtGusdPrecise(last)}
                          <span className="ml-1 text-[10px] text-dim">{unit}</span>
                        </td>
                        <td className="num px-2.5 py-2.5 text-right font-bold text-bright">
                          {value === null ? "—" : fmtGusd(value)}
                        </td>
                        <td
                          className={`num py-2.5 pr-3.5 text-right whitespace-nowrap ${
                            flat || pnl === null ? "text-dim" : pnl >= 0 ? "font-bold text-up" : "font-bold text-down"
                          }`}
                        >
                          {pnl === null || pnlPct === null
                            ? "—"
                            : `${fmtNotional(Math.abs(pnl))} · ${fmtPctSigned(pnlPct)}`}
                          {!flat && pnl !== null && (
                            <span aria-hidden className="ml-1 text-[8px]">
                              {pnl >= 0 ? "▲" : "▼"}
                            </span>
                          )}
                          {p.realizedPnl !== null && (
                            <span className="block text-[10px] font-normal text-dim">
                              realized {p.realizedPnl < 0 ? "−" : "+"}
                              {fmtNotional(Math.abs(p.realizedPnl))}
                            </span>
                          )}
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
              <Line label="Trade with gUSD" value="Terminal ▸" href="/spot" />
              <Line label="Mint gUSD" value="gUSD section ▸" href="/gusd" />
            </dl>
          </TuiPanel>

          <TuiPanel no="03" title="Earning capital · sgUSD" meta="gUSD deployed">
            <dl className="border-t border-rule">
              <Line label="sgUSD balance" value={`${fmtUnitsMax(account.sGUsdBalance)} sgUSD`} />
              <Line label="Value at rate" value={fmtGusd(sGUsdValue)} />
              {vaultBasis === null || vaultBasis.avgEntry === null ? (
                <Line
                  label="Avg entry"
                  value="—"
                  title={vaultBasis?.basisReason ?? undefined}
                />
              ) : (
                <Line label="Avg entry" value={`${fmtGusdPrecise(vaultBasis.avgEntry)} gUSD / sgUSD`} />
              )}
              {vaultBasis?.realizedPnl !== null && vaultBasis !== null && (
                <Line
                  label="Realized"
                  value={`${vaultBasis.realizedPnl < 0 ? "−" : "+"}${fmtNotional(Math.abs(vaultBasis.realizedPnl))} gUSD`}
                />
              )}
              <Line label="Stake and unstake" value="gUSD section ▸" href="/gusd" />
            </dl>
          </TuiPanel>

          <PerpPanel />

          </div>

        {/* 05 — activity: the indexed ledger merged with this session's
            in-flight / not-yet-indexed actions, newest first */}
        <TuiPanel
          no="05"
          title="Activity"
          meta={
            hasIndexed
              ? `${indexedRows.length + sessionCards.length} entries · newest first`
              : `${sessionCards.length} actions · this session · newest first`
          }
        >
          {indexedRows.length === 0 && sessionCards.length === 0 ? (
            <p className="p-3.5 text-[11.5px] leading-relaxed text-dim">
              Nothing has cleared yet. Orders, mints, and stakes print here as they settle.
            </p>
          ) : (
            <div className="border-t border-rule">
              {mergeFeed(indexedRows, sessionCards).map((entry) =>
                entry.kind === "indexed" ? (
                  <IndexedRow key={entry.key} row={entry.row} />
                ) : (
                  <SessionRow key={entry.key} record={entry.record} />
                ),
              )}
              {(activity.hasMoreExecutions || activity.hasMoreEvents) && (
                <div className="px-3.5 py-2.5">
                  <button
                    type="button"
                    onClick={activity.loadEarlier}
                    className="slug border border-rule-strong px-2 py-1 text-[9px] text-dim transition-colors hover:text-amber"
                  >
                    Load earlier
                  </button>
                </div>
              )}
            </div>
          )}
        </TuiPanel>
      </div>
    </div>
  );
}

/**
 * 04 — perp book: the wallet's gUSD-settled perpetual positions, as the
 * public record projected them, re-marked at the benchmark reference every
 * desk displays (uPnL is preview math at that reference — not the chain's
 * settlement price; the perps desk owns the verified probes). The
 * claimable counter reads the chain when a session exists and the public
 * record's projection otherwise; lag prints "—", never a zero. Live
 * positions link to their perp desk.
 */
function PerpPanel() {
  const session = useWalletSession();
  const connected = session.status === "connected";
  const markets = useMarkets();
  const { perp } = useServices();
  const actions = useActions();
  const active = useActiveAction("perp-claim");
  const [indexed, setIndexed] = useState<readonly IndexedPerpPosition[] | null>(null);
  const [claimable, setClaimable] = useState<number | null>(null);
  const [settled, setSettled] = useState<ActionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Settled actions move the chain counters — refetch when the terminal
  // count changes, then lazily on an interval.
  const settledCount = actions.filter((a) => isActionTerminal(a.phase)).length;

  useEffect(() => {
    const owner =
      connected && session.status === "connected" ? (session.address?.toLowerCase() ?? null) : null;
    if (owner === null) {
      setIndexed(null);
      setClaimable(null);
      return;
    }
    let alive = true;
    const load = () => {
      fetchIndexedPerpPositions(owner).then((rows) => {
        if (alive) setIndexed(rows);
      });
      // The claim figure prefers chain truth (the port answers null
      // without a session); the indexed projection fills the gap while
      // the wallet is gone.
      perp
        .getClaimable()
        .then((c) => {
          if (alive && c !== null) setClaimable(c);
        })
        .catch(() => {});
      fetchIndexedPerpClaimable(owner).then((c) => {
        if (alive) setClaimable((prev) => prev ?? c);
      });
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [connected, session, perp, settledCount]);

  const priceOf = new Map(markets.map((m) => [m.asset.id, m.marketPrice ?? m.indexPrice]));
  const live = (indexed ?? []).filter((p) => p.sizeUsd > 0 && p.closedAtSec === null);

  async function claim() {
    if (active !== null || claimable === null || claimable <= 0) return;
    setError(null);
    try {
      const record = await perp.claim(claimable);
      setSettled(record);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The claim didn't go through. Try again in a moment.");
    }
  }

  return (
    <TuiPanel
      no="04"
      title="Perp positions"
      meta="gUSD-settled · public record"
    >
      {indexed === null ? (
        <p className="px-3.5 py-3 text-[11.5px] leading-relaxed text-dim">
          Perp positions print here once the indexer reflects them. Live figures — uPnL, equity, liquidation
          distance — live on the{" "}
          <Link href="/perps" className="text-data underline decoration-rule-strong underline-offset-2 hover:text-bright">
            perps desk
          </Link>
          .
        </p>
      ) : live.length === 0 ? (
        <p className="px-3.5 py-3 text-[11.5px] leading-relaxed text-dim">
          No open perp positions.{" "}
          <Link href="/perps" className="text-data underline decoration-rule-strong underline-offset-2 hover:text-bright">
            Open one on the perps desk ▸
          </Link>
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-rule text-left">
                <th scope="col" className="slug py-2 pl-3.5 pr-4 text-dim">Market</th>
                <th scope="col" className="slug px-2.5 py-2 text-dim">Side</th>
                <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Size</th>
                <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Entry</th>
                <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Mark</th>
                <th scope="col" className="slug py-2 pr-3.5 text-right text-dim">uPnL / gUSD</th>
              </tr>
            </thead>
            <tbody>
              {live.map((p) => {
                const mark = priceOf.get(p.asset) ?? null;
                const uPnlRaw =
                  mark === null
                    ? null
                    : pnl(
                        BigInt(Math.round(p.sizeUsd * 1e6)),
                        BigInt(Math.round(p.entryPrice * 1e4)),
                        p.side === "long",
                        BigInt(Math.round(mark * 1e4)),
                      );
                const uPnl = uPnlRaw === null ? null : Number(uPnlRaw);
                return (
                  <tr key={`${p.asset}-${p.side}`} className="border-b border-rule last:border-b-0">
                    <td className="py-2.5 pl-3.5 pr-4">
                      <Link
                        href={`/perps/${p.asset}`}
                        className="num text-[13px] font-bold text-data transition-colors hover:text-bright"
                      >
                        {pairName(p.asset)}
                      </Link>
                    </td>
                    <td className={`slug px-2.5 py-2.5 ${p.side === "long" ? "text-up" : "text-down"}`}>
                      {p.side === "long" ? "▲ long" : "▼ short"}
                    </td>
                    <td className="num px-2.5 py-2.5 text-right text-data">{fmtUnitsMax(p.sizeUsd)}</td>
                    <td className="num px-2.5 py-2.5 text-right text-data">{fmtGusdPrecise(p.entryPrice)}</td>
                    <td className="num px-2.5 py-2.5 text-right text-data">
                      {mark === null ? "—" : fmtGusdPrecise(mark)}
                    </td>
                    <td
                      className={`num py-2.5 pr-3.5 text-right whitespace-nowrap ${
                        uPnl === null ? "text-dim" : uPnl >= 0 ? "font-bold text-up" : "font-bold text-down"
                      }`}
                    >
                      {uPnl === null ? "—" : fmtSignedGusd(uPnl)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {live.length > 0 && (
        <p className="px-3.5 pb-3 pt-2 slug text-[10px] text-dim">
          Rows are the public record's last touch — uPnL re-marks at the benchmark reference above, not the chain's
          settlement price. The perps desk's verified marks are the figures to act on.
        </p>
      )}
      <dl className="border-t border-rule">
        <div className="flex items-baseline justify-between gap-2 border-b border-rule px-3.5 py-2.5">
          <dt className="slug text-[10.5px] text-dim">Claimable settlements</dt>
          <dd className="num text-[12px] font-bold text-bright">
            {claimable === null ? "—" : `${fmtGusdPrecise(claimable)} gUSD`}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2 px-3.5 py-2.5">
          <dt className="slug text-[10.5px] text-dim">Settle claimable</dt>
          <dd>
            <button
              type="button"
              onClick={claim}
              disabled={active !== null || claimable === null || claimable <= 0}
              className="slug rev-g px-3 py-1 text-rev-fg transition-opacity disabled:cursor-not-allowed disabled:opacity-40 hover:opacity-90"
            >
              {active !== null ? "Claiming…" : "Claim"}
            </button>
          </dd>
        </div>
      </dl>
      {error && (
        <p className="mx-3.5 mb-3.5 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
          {error}
        </p>
      )}
      {settled && (
        <div className="px-3.5 pb-3.5">
          <ActionStatus record={settled} />
        </div>
      )}
      <p className="px-3.5 pb-3.5 text-[11.5px] leading-relaxed text-dim">
        Claims pay from the sgUSD vault; a short vault pays partially and the remainder stays claimable.
      </p>
    </TuiPanel>
  );
}

function Line({
  label,
  value,
  href,
  title,
}: {
  label: string;
  value: string;
  href?: string;
  title?: string;
}) {
  const shell =
    "flex items-baseline justify-between gap-2 border-b border-rule px-3.5 py-2.5 last:border-b-0";
  if (href) {
    // The whole row navigates — the figure rides the same link, the label
    // carries the amber hover voice.
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

// --- activity feed ----------------------------------------------------------------

type FeedEntry =
  | { kind: "indexed"; key: string; t: number; row: ActivityRow }
  | { kind: "session"; key: string; t: number; record: ActionRecord };

/** One merged feed: indexed ledger rows interleaved with the session's
 *  in-flight / not-yet-indexed action cards, newest first. */
function mergeFeed(rows: readonly ActivityRow[], cards: readonly ActionRecord[]): FeedEntry[] {
  const entries: FeedEntry[] = [
    ...rows.map((row): FeedEntry => ({ kind: "indexed", key: row.id, t: row.t, row })),
    ...cards.map((record): FeedEntry => ({
      kind: "session",
      key: record.id,
      t: record.createdAt,
      record,
    })),
  ];
  return entries.sort((a, b) => b.t - a.t);
}

/** The row's product label: "Buy 2.000 H100", or the verb with its gUSD
 *  figure when the event carries no GPU side ("Mint 10.0000 gUSD"). */
function rowLabel(r: ActivityRow): string {
  if (r.size !== null && r.asset !== null) return `${r.verb} ${fmtUnits(r.size)} ${r.asset}`;
  if (r.notional !== null) return `${r.verb} ${fmtGusdPrecise(r.notional)} gUSD`;
  return r.verb;
}

function IndexedRow({ row }: { row: ActivityRow }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 border-b border-rule px-3.5 py-2 last:border-b-0">
      <span className="num w-20 shrink-0 whitespace-nowrap text-[11px] text-dim">
        {fmtClock(row.t)} <span className="text-[9px]">UTC</span>
      </span>
      <span className="num min-w-0 flex-1 truncate text-[12.5px] font-bold text-data">
        {rowLabel(row)}
      </span>
      <span className="slug border border-rule-strong px-1.5 py-0.5 text-[8.5px] text-dim">
        indexed
      </span>
    </div>
  );
}

function SessionRow({ record }: { record: ActionRecord }) {
  const hashes = record.steps.flatMap((s) => (s.hash !== null ? [s.hash.toLowerCase()] : []));
  const reflected =
    record.indexed !== null && hashes.some((h) => record.indexed!.includes(h));
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 border-b border-rule px-3.5 py-2 last:border-b-0">
      <span className="num w-20 shrink-0 whitespace-nowrap text-[11px] text-dim">
        {fmtClock(record.createdAt)} <span className="text-[9px]">UTC</span>
      </span>
      <span className="num min-w-0 flex-1 truncate text-[12.5px] font-bold text-data">
        {record.label}
      </span>
      {reflected && (
        <span className="slug border border-rule-strong px-1.5 py-0.5 text-[8.5px] text-dim">
          indexed
        </span>
      )}
      <PhaseTag phase={record.phase} />
    </div>
  );
}
