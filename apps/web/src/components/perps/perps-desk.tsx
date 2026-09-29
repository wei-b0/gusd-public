"use client";

/**
 * PerpsDesk — the gUSD-settled perpetuals desk, pre-bound to one market.
 *
 * Architecture note: orders are two-stage. The desk arms them (the engine
 * locks collateral + the keeper's execution fee) and the keeper executes
 * against a fresh oracle report later — so nothing here pins a report into
 * the submit. Quotes price at the current attestation with the same
 * debounce doctrine the spot slip runs; the position/orders/claim panels
 * poll verified probes (verify-only — they never consume a report) on a
 * lazy interval, not on every tick.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ActionRecord } from "@/domain/actions";
import type {
  AssetId,
  PerpCloseQuote,
  PerpMarketState,
  PerpOpenQuote,
  PerpOrderKind,
  PerpPendingOrder,
  PerpPositionState,
  PerpSide,
} from "@/domain/types";
import { Pair } from "@/components/ui/pair";
import { ActionStatus } from "@/components/ui/action-status";
import { WalletlessNote } from "@/components/ui/walletless-note";
import { TuiPanel } from "@/components/ui/panel";
import {
  useAccount,
  useActiveAction,
  useMarkets,
  useServices,
  useWalletSession,
} from "@/data/services";
import { fmtAge, fmtGusd, fmtGusdLedger, fmtGusdPrecise, fmtNotional, fmtUnitsMax } from "@/domain/format";
import { DEFAULT_TOLERANCE_BPS, TOLERANCE_PRESETS_BPS } from "@/data/web3/trading/quotes";
import { triggerMet } from "@/data/web3/perps/triggers";
import { ORACLE_PANELS } from "@/data/oracle/panel-map";

const QUOTE_DEBOUNCE_MS = 250;
const QUOTE_RETRY_MS = 1_500;
/** Verified probes are read-backed (no report consumption); a lazy poll
 *  keeps the panels honest without hammering the RPC. */
const POLL_MS = 15_000;

/** asset → perp desk link, for the desk's market rail. */
const PERP_ASSETS = Object.keys(ORACLE_PANELS) as AssetId[];

const KIND_LABEL: Record<PerpOrderKind, string> = {
  open: "OPEN",
  close: "CLOSE",
  "stop-loss": "SL",
  "take-profit": "TP",
};

/** Price floats → the engine's 4-dec raw (for trigger sanity hints). */
function priceRaw(price: number): bigint {
  return BigInt(Math.round(price * 10_000));
}

function num(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/\.?0+$/, "");
}

/* ------------------------------------------------------------------ */
/* desk shell                                                          */
/* ------------------------------------------------------------------ */

export function PerpsDesk({ asset }: { asset: AssetId }) {
  const { perp } = useServices();
  const session = useWalletSession();
  const markets = useMarkets();
  const account = useAccount();
  const connected = session.status === "connected";

  const [market, setMarket] = useState<PerpMarketState | null | undefined>(undefined);
  const [book, setBook] = useState<{
    long: PerpPositionState | null;
    short: PerpPositionState | null;
    orders: PerpPendingOrder[] | null;
    claimable: number | null;
  }>({ long: null, short: null, orders: null, claimable: null });
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((k) => k + 1);

  // The perp market's chain state — one read per asset.
  useEffect(() => {
    let alive = true;
    setMarket(undefined);
    perp
      .describeMarket(asset)
      .then((m) => {
        if (alive) setMarket(m);
      })
      .catch(() => {
        if (alive) setMarket(null);
      });
    return () => {
      alive = false;
    };
  }, [perp, asset]);

  // The book the desk renders from: verified position probes on both
  // sides, pending orders, and the claimable counter — refreshed lazily.
  // Without a wallet the whole loop stays silent (nulls are the honest
  // empties, not zeros).
  useEffect(() => {
    if (!connected) {
      setBook({ long: null, short: null, orders: null, claimable: null });
      return;
    }
    let alive = true;
    const load = () => {
      Promise.all([
        perp.getPosition(asset, "long").catch(() => null),
        perp.getPosition(asset, "short").catch(() => null),
        perp.listPendingOrders().catch(() => null),
        perp.getClaimable().catch(() => null),
      ]).then(([long, short, pending, claim]) => {
        if (!alive) return;
        setBook({ long, short, orders: pending ?? [], claimable: claim });
      });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [perp, asset, connected, refreshKey]);

  // The mark: the venue price when a market layer exists, otherwise the
  // API's Index — the same displayed-price doctrine every desk stands on.
  const row = markets.find((m) => m.asset.id === asset);
  const mark = row?.marketPrice ?? row?.indexPrice ?? null;

  return (
    <div>
      {/* market rail — the four settlement panels that carry perp markets */}
      <nav aria-label="Perp markets" className="mb-4 flex flex-wrap gap-2">
        {PERP_ASSETS.map((a) => (
          <Link
            key={a}
            href={`/perps/${a}`}
            aria-current={a === asset ? "page" : undefined}
            className={`slug border px-3 py-1.5 transition-colors ${
              a === asset
                ? "rev border-transparent"
                : "border-rule-strong text-dim hover:border-amber/50 hover:text-amber"
            }`}
          >
            {a}
          </Link>
        ))}
      </nav>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-5">
          <MarketStrip asset={asset} market={market} mark={mark} />
          <PositionPanel
            asset={asset}
            mark={mark}
            positions={book}
            connected={connected}
            onRefresh={bump}
          />
          <OrdersPanel orders={book.orders} connected={connected} onRefresh={bump} />
          <ClaimPanel claimable={book.claimable} connected={connected} onRefresh={bump} />
        </div>
        <div className="space-y-5">
          <OrderSlip
            asset={asset}
            market={market}
            mark={mark}
            connected={connected}
            balance={account.gUsdBalance}
            positions={book}
            onSettled={bump}
          />
          <TriggerPanel asset={asset} positions={book} connected={connected} mark={mark} onSettled={bump} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 01 — market strip                                                   */
/* ------------------------------------------------------------------ */

function MarketStrip({
  asset,
  market,
  mark,
}: {
  asset: AssetId;
  market: PerpMarketState | null | undefined;
  mark: number | null;
}) {
  const perDay = (ppm: number) => `${num((ppm * 86_400) / 10_000)}%/day`;
  return (
    <TuiPanel
      no="01"
      title={
        <>
          <Pair id={asset} /> perp
        </>
      }
      meta={market === undefined ? "checking the market onchain…" : undefined}
    >
      {market === undefined ? (
        <p className="px-3.5 py-3 text-[11.5px] leading-relaxed text-dim">Reading the market onchain…</p>
      ) : market === null ? (
        <p className="px-3.5 py-3 text-[11.5px] leading-relaxed text-dim">
          No perp market exists for this asset yet — markets open when the protocol registers them.
        </p>
      ) : (
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 px-3.5 py-3.5">
          <p className="disp text-[26px] leading-none text-bright">
            {mark === null ? "—" : fmtGusdPrecise(mark)}
          </p>
          <p className="num text-[11px] leading-relaxed text-dim">
            open interest {fmtGusd(market.openInterestLong)} long · {fmtGusd(market.openInterestShort)} short · cap{" "}
            {fmtGusd(market.maxOiUsd)}
          </p>
          <p className="num text-[11px] leading-relaxed text-dim">
            funding {perDay(market.fundingRateLongPpmPerSec)} long · {perDay(market.fundingRateShortPpmPerSec)} short ·
            borrow {perDay(market.borrowRatePpmPerSec)} both sides
          </p>
          <p className="num text-[11px] leading-relaxed text-dim">
            leverage ≤ {num(market.maxLeverageBps / 10_000)}× · fees {num(market.openFeeBps / 100)}% open /{" "}
            {num(market.closeFeeBps / 100)}% close / {num(market.liquidationFeeBps / 100)}% liq
          </p>
        </div>
      )}
    </TuiPanel>
  );
}

/* ------------------------------------------------------------------ */
/* 02 — positions                                                      */
/* ------------------------------------------------------------------ */

type PositionBook = {
  long: PerpPositionState | null;
  short: PerpPositionState | null;
  orders: PerpPendingOrder[] | null;
  claimable: number | null;
};

function PositionPanel({
  asset,
  mark,
  positions,
  connected,
  onRefresh,
}: {
  asset: AssetId;
  mark: number | null;
  positions: PositionBook;
  connected: boolean;
  onRefresh: () => void;
}) {
  const { perp } = useServices();
  const closeActive = useActiveAction("perp-close") !== null;
  const [settled, setSettled] = useState<ActionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sides = (["long", "short"] as const).filter((s) => positions[s] !== null);
  const anyPosition = sides.length > 0;

  async function marketClose(side: PerpSide) {
    if (closeActive) return;
    setError(null);
    try {
      const record = await perp.close({ asset, side, size: null });
      setSettled(record);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The close didn't arm. Try again in a moment.");
    }
  }

  return (
    <TuiPanel
      no="02"
      title="Positions"
      meta={connected ? (anyPosition ? `${sides.length} open` : "flat") : undefined}
    >
      {!connected && (
        <p className="px-3.5 py-3 text-[11.5px] leading-relaxed text-dim">
          Connect a wallet to hold perp positions.
        </p>
      )}
      {connected && !anyPosition && (
        <p className="px-3.5 py-3 text-[11.5px] leading-relaxed text-dim">
          Flat — no position on this market. Arm an open from the order slip.
        </p>
      )}
      {sides.map((side) => {
        const p = positions[side];
        if (p === null) return null;
        return (
          <PositionCard
            key={side}
            mark={mark}
            state={p}
            closeActive={closeActive}
            onClose={() => marketClose(side)}
          />
        );
      })}
      {settled && (
        <div className="px-3.5 pb-3.5">
          <ActionStatus record={settled} />
        </div>
      )}
      {error && (
        <p className="mx-3.5 mb-3.5 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
          {error}
        </p>
      )}
    </TuiPanel>
  );
}

function PositionCard({
  mark,
  state,
  closeActive,
  onClose,
}: {
  mark: number | null;
  state: PerpPositionState;
  closeActive: boolean;
  onClose: () => void;
}) {
  const long = state.side === "long";
  const liqDist =
    state.liquidationPrice !== null && mark !== null && mark > 0
      ? Math.abs((state.liquidationPrice - mark) / mark) * 100
      : null;
  return (
    <div className="border-b border-rule px-3.5 py-3 last:border-b-0">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <p className="num text-[13px] font-bold text-data">
          <span className={long ? "text-up" : "text-down"}>{long ? "▲ LONG" : "▼ SHORT"}</span>{" "}
          {fmtGusdLedger(state.sizeUsd)} notional
        </p>
        <button
          type="button"
          onClick={onClose}
          disabled={closeActive}
          className="slug border border-rule-strong px-3 py-1 text-dim transition-colors hover:text-bright disabled:cursor-not-allowed disabled:opacity-40"
        >
          {closeActive ? "closing…" : "Market close"}
        </button>
      </div>
      <dl className="num grid grid-cols-2 gap-x-6 gap-y-1.5 text-[11px] leading-relaxed sm:grid-cols-3">
        <Field label="collateral" value={`${fmtGusdLedger(state.collateral)} gUSD`} />
        <Field label="entry" value={fmtGusdPrecise(state.entryPrice)} />
        <Field label="mark" value={mark === null ? "—" : fmtGusdPrecise(mark)} />
        <Field
          label="uPnL"
          value={`${state.uPnl < 0 ? "−" : "+"}${fmtNotional(Math.abs(state.uPnl))} gUSD`}
          className={state.uPnl >= 0 ? "text-up" : "text-down"}
        />
        <Field label="equity" value={`${fmtGusdLedger(Math.max(state.equity, 0))} gUSD`} />
        <Field
          label="funding net"
          value={`${state.fundingNet <= 0 ? "+" : "−"}${fmtNotional(Math.abs(state.fundingNet))} gUSD`}
          className={state.fundingNet <= 0 ? "text-up" : "text-down"}
        />
        <Field label="maintenance" value={`${fmtGusdLedger(state.maintenance)} gUSD`} />
        <Field
          label="est. liquidation"
          value={state.liquidationPrice === null ? "—" : fmtGusdPrecise(state.liquidationPrice)}
        />
        <Field label="distance to liq" value={liqDist === null ? "—" : `${num(liqDist)}%`} />
      </dl>
      {state.liquidatable && (
        <p className="mt-2 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
          At the liquidation threshold — the next report past maintenance lets anyone liquidate. Close now; the
          position does not recover on its own.
        </p>
      )}
      <p className="mt-2 slug text-[10px] text-dim">
        uPnL marks the verified report price ({fmtAge(state.updatedAt, Date.now())} old) — accrued funding settles at
        the next onchain touch.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 03 — armed orders                                                   */
/* ------------------------------------------------------------------ */

function OrdersPanel({
  orders,
  connected,
  onRefresh,
}: {
  orders: PerpPendingOrder[] | null;
  connected: boolean;
  onRefresh: () => void;
}) {
  const { perp } = useServices();
  const active = useActiveAction("perp-cancel");
  const [settled, setSettled] = useState<ActionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function cancel(orderId: number) {
    if (active !== null) return;
    setError(null);
    try {
      const record = await perp.cancelOrder(orderId);
      setSettled(record);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The cancel didn't go through. Try again in a moment.");
    }
  }

  return (
    <TuiPanel no="03" title="Armed orders" meta={orders === null ? undefined : `${orders.length} pending`}>
      <div className="px-3.5 pb-1 pt-2.5 text-[11.5px] leading-relaxed text-dim">
        Orders lock their collateral and the keeper's execution fee, then wait for execution against a fresh oracle
        report — typically within one epoch. A close that prints past its price bound stays armed for the next epoch.
      </div>
      {!connected ? (
        <p className="px-3.5 pb-3.5 text-[11.5px] leading-relaxed text-dim">Connect a wallet to see your orders.</p>
      ) : orders === null ? (
        <p className="px-3.5 pb-3.5 text-[11.5px] leading-relaxed text-dim">Reading orders…</p>
      ) : orders.length === 0 ? (
        <p className="px-3.5 pb-3.5 text-[11.5px] leading-relaxed text-dim">Nothing armed.</p>
      ) : (
        <ul className="border-t border-rule">
          {orders.map((o) => (
            <li
              key={o.orderId}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule px-3.5 py-2 last:border-b-0"
            >
              <span className="num text-[11px] text-data">
                <span className="font-bold text-amber">#{o.orderId}</span>{" "}
                <span className={o.side === "long" ? "text-up" : "text-down"}>{KIND_LABEL[o.kind]}</span>{" "}
                {o.kind === "open" ? (
                  <>
                    {fmtGusdLedger(o.sizeUsd)} @ bound {fmtGusdPrecise(o.price)} · locked {fmtGusdLedger(o.collateral)}{" "}
                    gUSD
                  </>
                ) : o.kind === "close" ? (
                  <>
                    close {fmtGusdLedger(o.sizeUsd)} @ bound {fmtGusdPrecise(o.price)}
                  </>
                ) : (
                  <>
                    {o.sizeUsd === 0 ? "whole position" : `close ${fmtGusdLedger(o.sizeUsd)}`} {o.side} @ trigger{" "}
                    {fmtGusdPrecise(o.price)}
                  </>
                )}
              </span>
              <span className="flex items-baseline gap-3">
                <span className="slug text-[10px] text-dim">armed {fmtAge(o.createdAt, Date.now())}</span>
                <button
                  type="button"
                  onClick={() => cancel(o.orderId)}
                  disabled={active !== null}
                  className="slug border border-rule-strong px-2.5 py-0.5 text-dim transition-colors hover:text-bright disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {active !== null ? "…" : "Cancel"}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {settled && (
        <div className="px-3.5 pb-3.5">
          <ActionStatus record={settled} />
        </div>
      )}
      {error && (
        <p className="mx-3.5 mb-3.5 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
          {error}
        </p>
      )}
    </TuiPanel>
  );
}

/* ------------------------------------------------------------------ */
/* 04 — claimable                                                      */
/* ------------------------------------------------------------------ */

function ClaimPanel({
  claimable,
  connected,
  onRefresh,
}: {
  claimable: number | null;
  connected: boolean;
  onRefresh: () => void;
}) {
  const { perp } = useServices();
  const active = useActiveAction("perp-claim");
  const [settled, setSettled] = useState<ActionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function claim() {
    if (active !== null || claimable === null || claimable <= 0) return;
    setError(null);
    try {
      const record = await perp.claim(claimable);
      setSettled(record);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The claim didn't go through. Try again in a moment.");
    }
  }

  return (
    <TuiPanel no="04" title="Settled · claimable" meta="paid from the sgUSD vault">
      <div className="flex flex-wrap items-baseline justify-between gap-3 px-3.5 py-3.5">
        <p className="disp text-[20px] leading-none text-bright">
          {claimable === null ? "—" : `${fmtGusdLedger(claimable)} gUSD`}
        </p>
        <button
          type="button"
          onClick={claim}
          disabled={active !== null || claimable === null || claimable <= 0}
          className="slug rev-g w-auto px-4 py-1.5 text-rev-fg transition-opacity disabled:cursor-not-allowed disabled:opacity-40 hover:opacity-90"
        >
          {active !== null ? "Claiming…" : "Claim"}
        </button>
      </div>
      <p className="px-3.5 pb-3.5 text-[11.5px] leading-relaxed text-dim">
        Closes, triggers, and liquidation remainders settle here in accounting, then pay out on claim. The vault pays
        what it holds — a short claim leaves the remainder claimable.
      </p>
      {settled && (
        <div className="px-3.5 pb-3.5">
          <ActionStatus record={settled} />
        </div>
      )}
      {error && (
        <p className="mx-3.5 mb-3.5 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
          {error}
        </p>
      )}
    </TuiPanel>
  );
}

/* ------------------------------------------------------------------ */
/* 05 — order slip (open / close)                                      */
/* ------------------------------------------------------------------ */

function OrderSlip({
  asset,
  market,
  mark,
  connected,
  balance,
  positions,
  onSettled,
}: {
  asset: AssetId;
  market: PerpMarketState | null | undefined;
  mark: number | null;
  connected: boolean;
  balance: number;
  positions: PositionBook;
  onSettled: () => void;
}) {
  const { perp } = useServices();
  const [mode, setMode] = useState<"open" | "close">("open");
  const [side, setSide] = useState<PerpSide>("long");
  const [collText, setCollText] = useState("");
  const [leverage, setLeverage] = useState(2);
  const [toleranceBps, setToleranceBps] = useState<number>(DEFAULT_TOLERANCE_BPS);
  const [closePct, setClosePct] = useState(100);
  const [quote, setQuote] = useState<PerpOpenQuote | PerpCloseQuote | null | undefined>(undefined);
  const [settled, setSettled] = useState<ActionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeOpen = useActiveAction("perp-open");
  const activeClose = useActiveAction("perp-close");
  const active = mode === "open" ? activeOpen : activeClose;

  const position = positions[side];
  const coll = Number(collText);
  const validInput = mode === "open" ? Number.isFinite(coll) && coll > 0 : position !== null;

  // Reset the receipt and any stale refusal when the shape of the request
  // changes — the settled record stays in the store's history.
  useEffect(() => {
    setSettled((s) => (s ? null : s));
    setError(null);
  }, [mode, side, collText, leverage, toleranceBps, closePct, position?.sizeUsd]);

  const maxLeverage = market === null || market === undefined ? 10 : market.maxLeverageBps / 10_000;
  const levPresets = [1, 2, 5, 10, 20].filter((l) => l <= maxLeverage);
  const effLeverage = Math.min(leverage, maxLeverage);
  const closeSize =
    mode === "close" && position !== null ? Math.floor(position.sizeUsd * (closePct / 100) * 1e6) / 1e6 : null;

  // The execution quote re-prices on every settled input and after an
  // action lands (the balances and position state behind it moved).
  // undefined marks the in-flight window; null after one patient retry is
  // the refusal voice — never retried away a second time.
  useEffect(() => {
    if (!validInput || mark === null) {
      setQuote(undefined);
      return;
    }
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setQuote(undefined);
    const timer = setTimeout(() => {
      const attempt = (retry: boolean) => {
        const p =
          mode === "open"
            ? perp.quoteOpen({ asset, side, collateral: coll, leverage: effLeverage, toleranceBps })
            : perp.quoteClose({ asset, side, size: closeSize, toleranceBps });
        p.then((q) => {
          if (!alive) return;
          if (q === null && retry) {
            retryTimer = setTimeout(() => attempt(false), QUOTE_RETRY_MS);
            return;
          }
          setQuote(q);
        }).catch(() => {
          if (alive) setQuote(null);
        });
      };
      attempt(true);
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
      clearTimeout(retryTimer);
    };
  }, [perp, asset, mode, side, coll, effLeverage, toleranceBps, validInput, mark, closeSize, position?.sizeUsd]);

  // The open side's local pre-flight — the same checks the engine runs,
  // spoken in place before the chain even quotes (quoteOpen answers null
  // for all of them; the desk can name which one).
  const openGate: string | null =
    market === undefined
      ? null // still checking — dashes, not a refusal
      : market === null
        ? "No perp market exists for this asset yet — markets open when the protocol registers them."
        : !market.enabled
          ? "This perp market is disabled by the protocol right now."
          : validInput && coll < market.minCollateralUsd
            ? `That collateral is under this market's minimum of ${fmtGusdLedger(market.minCollateralUsd)} gUSD — raise the amount.`
            : validInput && coll > balance
              ? "The wallet's gUSD balance is too low for this order — check the amount."
              : validInput && (sizeOf(coll, effLeverage) > market.maxPositionUsd || openInterestOver(market, side, coll, effLeverage))
                ? "That order exceeds this market's caps — size down (per-position and open-interest limits print on the market strip)."
                : null;

  const gate: string | null =
    mode === "open"
      ? openGate
      : position === null
        ? "There's no position on this side to close — it may have settled already."
        : null;

  const quoteRefused = gate === null && validInput && mark !== null && quote === null;
  const quoteGate: string | null = !quoteRefused
    ? null
    : mode === "open"
      ? "This order doesn't fit the market's rules — check the minimum collateral, leverage cap, and open-interest room."
      : "Nothing to quote this close against — the position may have settled already.";

  async function onSubmit() {
    if (!connected) {
      setError("Connect a wallet to trade perps — nothing signs without one.");
      return;
    }
    if (!validInput) {
      setError(mode === "open" ? "Enter a gUSD collateral amount greater than zero." : "There's no position to close.");
      return;
    }
    if (gate || quoteGate || quote === null || quote === undefined) return;
    setError(null);
    try {
      const record =
        mode === "open"
          ? await perp.open({ asset, side, collateral: coll, leverage: effLeverage, toleranceBps })
          : await perp.close({ asset, side, size: closePct === 100 ? null : closeSize, toleranceBps });
      setSettled(record);
      onSettled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The order didn't go through. Try again in a moment.");
    }
  }

  const longActive = side === "long";

  return (
    <TuiPanel
      no="05"
      title="Order slip"
      meta="two-stage · keeper executes"
      right={
        <div className="flex">
          {(["open", "close"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`slug px-2.5 py-0.5 transition-colors ${
                mode === m ? "rev" : "text-dim hover:text-data"
              }`}
            >
              {m.toUpperCase()}
            </button>
          ))}
        </div>
      }
    >
      <div className="space-y-3 p-3.5">
        {/* side */}
        <div className="grid grid-cols-2 gap-px border border-rule-strong bg-rule-strong">
          <button
            type="button"
            onClick={() => setSide("long")}
            className={`slug py-2 transition-colors ${longActive ? "rev-g text-rev-fg" : "bg-panel text-dim hover:text-data"}`}
          >
            ▲ LONG
          </button>
          <button
            type="button"
            onClick={() => setSide("short")}
            className={`slug py-2 transition-colors ${!longActive ? "rev-d text-rev-fg" : "bg-panel text-dim hover:text-data"}`}
          >
            ▼ SHORT
          </button>
        </div>

        {mode === "open" ? (
          <>
            {/* collateral */}
            <div>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <label htmlFor="perp-coll" className="slug text-[10px] text-dim">
                  COLLATERAL · gUSD
                </label>
                {connected && (
                  <button
                    type="button"
                    onClick={() => setCollText(fmtUnitsMax(balance))}
                    className="slug text-[10px] text-dim transition-colors hover:text-amber"
                  >
                    balance {fmtGusdLedger(balance)} · MAX
                  </button>
                )}
              </div>
              <input
                id="perp-coll"
                value={collText}
                onChange={(e) => setCollText(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                spellCheck={false}
                className="num w-full border border-rule-strong bg-transparent px-3 py-2.5 text-[15px] text-data outline-none focus-within:border-amber"
              />
            </div>
            {/* leverage */}
            <div>
              <p className="slug mb-1 text-[10px] text-dim">LEVERAGE · ≤ {num(maxLeverage)}×</p>
              <div className="flex flex-wrap gap-px border border-rule-strong bg-rule-strong">
                {levPresets.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLeverage(l)}
                    className={`num flex-1 py-1.5 text-[12px] transition-colors ${
                      effLeverage === l ? "rev" : "bg-panel text-dim hover:text-data"
                    }`}
                  >
                    {l}×
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : (
          <>
            {/* close fraction */}
            <div>
              <p className="slug mb-1 text-[10px] text-dim">
                CLOSE · {position === null ? "no position" : `${fmtGusdLedger(position.sizeUsd)} notional held`}
              </p>
              <div className="flex flex-wrap gap-px border border-rule-strong bg-rule-strong">
                {[25, 50, 75, 100].map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setClosePct(p)}
                    className={`num flex-1 py-1.5 text-[12px] transition-colors ${
                      closePct === p ? "rev" : "bg-panel text-dim hover:text-data"
                    }`}
                  >
                    {p}%
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* tolerance — the bound the armed order refuses to fill past */}
        <div>
          <p className="slug mb-1 text-[10px] text-dim">
            PRICE TOLERANCE · {mode === "open" ? (longActive ? "fills below" : "fills above") : longActive ? "closes above" : "closes below"} the bound
          </p>
          <div className="flex flex-wrap gap-px border border-rule-strong bg-rule-strong">
            {TOLERANCE_PRESETS_BPS.map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => setToleranceBps(b)}
                className={`num flex-1 py-1.5 text-[12px] transition-colors ${
                  toleranceBps === b ? "rev" : "bg-panel text-dim hover:text-data"
                }`}
              >
                {num(b / 100)}%
              </button>
            ))}
          </div>
        </div>

        {/* ledger */}
        <dl className="border-t border-rule">
          {mode === "open" ? (
            isQuote(quote) ? (
              <>
                <Row label="Collateral in" value={`${fmtGusdLedger(quote.collateral)} gUSD`} />
                <Row label="Position size" value={`${fmtGusdLedger(quote.sizeUsd)} gUSD`} strong />
                <Row label="Open fee" value={`${fmtGusdLedger(quote.openFee)} gUSD`} />
                <Row label="Execution fee" value={`${fmtGusdLedger(quote.executionFee)} gUSD`} />
                <Row
                  label={longActive ? "Refuses above" : "Refuses below"}
                  value={fmtGusdPrecise(quote.acceptablePrice)}
                />
                <Row label="Report price" value={fmtGusdPrecise(quote.referencePrice)} />
              </>
            ) : (
              <Row label="Position size" value="—" strong />
            )
          ) : isCloseQuote(quote) ? (
            <>
              <Row label="Closing" value={`${fmtGusdLedger(quote.sizeUsd)} gUSD of ${fmtGusdPrecise(quote.entryPrice)} entry`} />
              <Row
                label="PnL at report"
                value={`${quote.pnl < 0 ? "−" : "+"}${fmtNotional(Math.abs(quote.pnl))} gUSD`}
                strong
                className={quote.pnl >= 0 ? "text-up" : "text-down"}
              />
              <Row label="Close fee" value={`${fmtGusdLedger(quote.closeFee)} gUSD`} />
              <Row label="Execution fee" value={`${fmtGusdLedger(quote.executionFee)} gUSD`} />
              <Row
                label="Funding net"
                value={`${quote.fundingNet <= 0 ? "+" : "−"}${fmtNotional(Math.abs(quote.fundingNet))} gUSD`}
                className={quote.fundingNet <= 0 ? "text-up" : "text-down"}
              />
              <Row
                label="Settles to claimable"
                value={`${quote.proceeds < 0 ? "−" : "+"}${fmtNotional(Math.abs(quote.proceeds))} gUSD`}
                strong
              />
              <Row label="Report price" value={fmtGusdPrecise(quote.referencePrice)} />
            </>
          ) : (
            <Row label="Settles to claimable" value="—" strong />
          )}
        </dl>

        {market === undefined && (
          <p className="text-[11.5px] leading-relaxed text-dim">Checking the market onchain…</p>
        )}
        {mark === null && (
          <p className="text-[11.5px] leading-relaxed text-dim">
            No reference price yet — orders open when the feed asserts one.
          </p>
        )}
        {quote === undefined && gate === null && validInput && mark !== null && (
          <p className="text-[11.5px] leading-relaxed text-dim">Quoting against the current report…</p>
        )}

        <WalletlessNote />

        {gate && (
          <p className="border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">{gate}</p>
        )}
        {quoteGate && (
          <p className="border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
            {quoteGate}
          </p>
        )}
        {!connected && (
          <p className="text-[11.5px] leading-relaxed text-dim">
            Connect a wallet to trade — nothing signs without one.
          </p>
        )}
        {error && (
          <p className="border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">{error}</p>
        )}

        {(active ?? settled) && <ActionStatus record={(active ?? settled) as ActionRecord} />}

        <button
          type="button"
          onClick={onSubmit}
          disabled={active !== null || !validInput || quote === null || quote === undefined || gate !== null || quoteGate !== null || mark === null}
          className={`slug w-full py-2.5 text-rev-fg transition-opacity disabled:cursor-not-allowed disabled:opacity-40 hover:opacity-90 ${
            longActive ? "rev-g" : "rev-d"
          }`}
        >
          {active !== null ? (
            "Arming…"
          ) : (
            <>
              {mode === "open" ? "Open" : "Close"} {longActive ? "long" : "short"} <Pair id={asset} />
            </>
          )}
        </button>
        <p className="slug text-[10px] text-dim">
          Arming locks {mode === "open" ? "collateral and" : ""} the keeper's fee — execution lands within an epoch.
        </p>
      </div>
    </TuiPanel>
  );
}

function sizeOf(coll: number, leverage: number): number {
  return coll * leverage;
}

function openInterestOver(market: PerpMarketState, side: PerpSide, coll: number, leverage: number): boolean {
  const size = sizeOf(coll, leverage);
  const sideOi = side === "long" ? market.openInterestLong : market.openInterestShort;
  return sideOi + size > market.maxOiUsd;
}

/** Runtime narrowing — the open and close quote shapes share no fields the
 *  ledger needs to disambiguate on. */
function isQuote(
  q: PerpOpenQuote | PerpCloseQuote | null | undefined,
): q is PerpOpenQuote {
  return q !== null && q !== undefined && "openFee" in q;
}

function isCloseQuote(
  q: PerpOpenQuote | PerpCloseQuote | null | undefined,
): q is PerpCloseQuote {
  return q !== null && q !== undefined && "proceeds" in q;
}

/* ------------------------------------------------------------------ */
/* 06 — TP/SL triggers                                                 */
/* ------------------------------------------------------------------ */

function TriggerPanel({
  asset,
  positions,
  connected,
  mark,
  onSettled,
}: {
  asset: AssetId;
  positions: PositionBook;
  connected: boolean;
  mark: number | null;
  onSettled: () => void;
}) {
  const sides = (["long", "short"] as const).filter((s) => positions[s] !== null);
  if (!connected || sides.length === 0) {
    return (
      <TuiPanel no="06" title="Stop-loss · take-profit" meta="armed per position">
        <p className="px-3.5 py-3 text-[11.5px] leading-relaxed text-dim">
          {connected
            ? "Arm a trigger from here once a position is open."
            : "Connect a wallet to arm triggers."}
        </p>
      </TuiPanel>
    );
  }
  return (
    <TuiPanel no="06" title="Stop-loss · take-profit" meta="armed per position">
      {sides.map((side) => (
        <TriggerForm key={side} asset={asset} side={side} mark={mark} onSettled={onSettled} />
      ))}
    </TuiPanel>
  );
}

function TriggerForm({
  asset,
  side,
  mark,
  onSettled,
}: {
  asset: AssetId;
  side: PerpSide;
  mark: number | null;
  onSettled: () => void;
}) {
  const { perp } = useServices();
  const [kind, setKind] = useState<"stop-loss" | "take-profit">("stop-loss");
  const [triggerText, setTriggerText] = useState("");
  const [settled, setSettled] = useState<ActionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useActiveAction("perp-trigger");

  const trigger = Number(triggerText);
  const valid = Number.isFinite(trigger) && trigger > 0;

  // A trigger past the mark on the firing side prints immediately —
  // not a refusal (SL has no floor by design), just a hint before the
  // keeper fills it within an epoch.
  const wrongSideHint =
    valid && mark !== null
      ? triggerMet(kind, side === "long", priceRaw(trigger), priceRaw(mark))
        ? "That trigger has already printed against the mark — the keeper fills it within an epoch."
        : null
      : null;

  useEffect(() => {
    setSettled((s) => (s ? null : s));
    setError(null);
  }, [kind, triggerText]);

  async function arm() {
    if (active !== null || !valid) return;
    setError(null);
    try {
      const record = await perp.armTrigger({ asset, side, kind, triggerPrice: trigger, size: null });
      setSettled(record);
      onSettled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The trigger didn't arm. Try again in a moment.");
    }
  }

  const long = side === "long";
  const dirHint =
    kind === "take-profit"
      ? long
        ? "fires when mark ≥ trigger"
        : "fires when mark ≤ trigger"
      : long
        ? "fires when mark ≤ trigger"
        : "fires when mark ≥ trigger";

  return (
    <div className="border-b border-rule px-3.5 py-3 last:border-b-0">
      <p className="num mb-2 text-[12px] font-bold text-data">
        <span className={long ? "text-up" : "text-down"}>{long ? "▲ LONG" : "▼ SHORT"}</span> position
      </p>
      <div className="mb-2 flex flex-wrap gap-px border border-rule-strong bg-rule-strong">
        {(["stop-loss", "take-profit"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`slug flex-1 py-1.5 transition-colors ${kind === k ? "rev" : "bg-panel text-dim hover:text-data"}`}
          >
            {k === "stop-loss" ? "STOP-LOSS" : "TAKE-PROFIT"}
          </button>
        ))}
      </div>
      <input
        value={triggerText}
        onChange={(e) => setTriggerText(e.target.value)}
        inputMode="decimal"
        placeholder="trigger price · USD / GPU-hour"
        spellCheck={false}
        aria-label={`Trigger price for the ${side} position`}
        className="num w-full border border-rule-strong bg-transparent px-3 py-2.5 text-[15px] text-data outline-none focus-within:border-amber"
      />
      <p className="slug mt-1.5 text-[10px] text-dim">
        {dirHint} · {mark === null ? "no mark yet" : `mark ${fmtGusdPrecise(mark)}`} · replaces any armed{" "}
        {kind === "stop-loss" ? "stop-loss" : "take-profit"} on this position
      </p>
      {wrongSideHint && (
        <p className="mt-2 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
          {wrongSideHint}
        </p>
      )}
      {error && (
        <p className="mt-2 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
          {error}
        </p>
      )}
      {settled && (
        <div className="mt-2">
          <ActionStatus record={settled} />
        </div>
      )}
      <button
        type="button"
        onClick={arm}
        disabled={active !== null || !valid}
        className="slug rev-g w-full py-2 text-rev-fg transition-opacity disabled:cursor-not-allowed disabled:opacity-40 hover:opacity-90"
      >
        {active !== null ? "Arming…" : `Arm ${kind === "stop-loss" ? "stop-loss" : "take-profit"}`}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* shared bits                                                         */
/* ------------------------------------------------------------------ */

function Field({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div>
      <dt className="slug text-[10px] text-dim">{label}</dt>
      <dd className={`text-data ${className ?? ""}`}>{value}</dd>
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  className,
}: {
  label: string;
  value: string;
  strong?: boolean;
  className?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-rule py-2 last:border-b-0">
      <dt className="slug text-[10.5px] text-dim">{label}</dt>
      <dd className={`num text-[12px] whitespace-nowrap ${strong ? "font-bold text-bright" : "text-data"} ${className ?? ""}`}>
        {value}
      </dd>
    </div>
  );
}