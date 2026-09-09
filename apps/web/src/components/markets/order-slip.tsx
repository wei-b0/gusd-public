"use client";

/**
 * OrderSlip — the trade furniture inside the Trade panel. Every order
 * names its basis: money-first (the default — type the gUSD to spend on a
 * buy, or the gUSD to receive on a sell, and see the approx units) or
 * size-first (type the units). Quotes come from the router stack itself
 * (the contract's own quoteIssue and the hook-aware GpuQuoter — the same
 * pricing path execution runs); execution re-quotes fresh at submit and
 * runs through the action runner, so every submit walks quote → approval →
 * signature → confirmation as one visible action, bounded by the signed
 * limits rather than the displayed numbers. Money-first buys pull the
 * typed spend exactly — nothing is refunded — so their cap row reads the
 * typed amount and the guarantee is the minimum-units floor; money-first
 * sells sign a payout floor. Pricing has one authoritative source on the
 * frontend: the API. Every figure the ledger prints derives from that
 * one price — the Price row restates it verbatim, and the ~ rows are
 * the typed order run through it — so hero, chart, feed, and ticket all
 * quote the same number and the eye never catches a second truth. The
 * chain oracle refines only the bound rows, and only on its favorable
 * side: a lower oracle lifts a receive floor, a higher one raises a pay
 * cap; otherwise the bound stays on the anchor. What the contracts
 * actually fill is signed fresh at submit from a live quote — any gap
 * between the anchored ledger and the fill is slippage, read in the
 * receipt, never a second displayed price. When the data layer asserts
 * no reference price, the slip goes dormant rather than quoting against
 * nothing.
 *
 * Unavailable markets speak in place: an unregistered asset, a closed
 * issuance, or an empty pool each get their own honest voice — never a
 * silent dead button.
 */

import { useEffect, useState, type ReactNode } from "react";
import type { ActionRecord } from "@/domain/actions";
import type { TradeAvailability, TradeQuote, TradeRequest, TradeSide } from "@/domain/types";
import { parseAssetId } from "@/domain/types";
import { fmtGusdLedger, fmtUnits, fmtUnitsLedger } from "@/domain/format";
import { Pair } from "@/components/ui/pair";
import { ActionStatus } from "@/components/ui/action-status";
import { WalletlessNote } from "@/components/ui/walletless-note";
import { useAccount, useActiveAction, useServices, useWalletSession } from "@/data/services";
import { DEFAULT_TOLERANCE_BPS, TOLERANCE_PRESETS_BPS } from "@/data/web3/trading/quotes";

export interface OrderSlipProps {
  assetId: string;
  /** The displayed price — the slip goes dormant without it. */
  referencePrice: number | null;
}

/** Debounce for the async quote calls — one per settled input, not one per keystroke. */
const QUOTE_DEBOUNCE_MS = 250;

/** The gUSD-value presets in money-first mode, and the unit presets in
 *  size-first mode — each sized to the orders that basis invites. */
const GUSD_PRESETS = [10, 50, 100] as const;
const UNIT_PRESETS = [1, 4, 10] as const;

/** MAX writes the exact holding into the input — a rounded-up max would
 *  fail its own pre-flight. Balances arrive at 6-decimals grain; a sell's
 *  position is floored to that grain before it ever reaches the input. */
function maxText(value: number): string {
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function OrderSlip({ assetId, referencePrice }: OrderSlipProps) {
  const { trading } = useServices();
  const account = useAccount();
  const session = useWalletSession();
  const active = useActiveAction("trade");
  const [side, setSide] = useState<TradeSide>("buy");
  const [mode, setMode] = useState<"gusd" | "units">("gusd");
  const [unitsText, setUnitsText] = useState("1");
  const [gusdText, setGusdText] = useState("10");
  const [toleranceBps, setToleranceBps] = useState(DEFAULT_TOLERANCE_BPS);
  const [availability, setAvailability] = useState<TradeAvailability | null | undefined>(undefined);
  /** undefined = quoting, null = the chain can't quote this order, else the quote. */
  const [quote, setQuote] = useState<TradeQuote | null | undefined>(undefined);
  const [settled, setSettled] = useState<ActionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Per-mode text survives toggles and side switches — switching basis
  // never throws away what the user already typed there.
  const activeText = mode === "gusd" ? gusdText : unitsText;
  const activeValue = Number(activeText);
  const validInput = Number.isFinite(activeValue) && activeValue > 0;
  const setActiveText = mode === "gusd" ? setGusdText : setUnitsText;
  const asset = parseAssetId(assetId);
  const connected = session.status === "connected" && account.connected;

  // The market's onchain gate — one read per asset, kept by the port.
  useEffect(() => {
    if (!asset) return;
    let alive = true;
    setAvailability(undefined);
    trading
      .describeAsset(asset)
      .then((a) => {
        if (alive) setAvailability(a);
      })
      .catch(() => {
        if (alive) setAvailability(null);
      });
    return () => {
      alive = false;
    };
  }, [trading, asset]);

  // The execution quote re-prices on every settled input and after an
  // order lands (the balances behind presets and caps moved). undefined
  // marks the in-flight window so the "can't quote" voice only speaks
  // once the chain has actually answered.
  useEffect(() => {
    if (!asset || !validInput || referencePrice === null) {
      setQuote(null);
      return;
    }
    let alive = true;
    setQuote(undefined);
    const timer = setTimeout(() => {
      const request: TradeRequest =
        mode === "gusd"
          ? { asset, side, basis: "gusd", gusd: activeValue, toleranceBps }
          : { asset, side, basis: "units", size: activeValue, toleranceBps };
      trading
        .quote(request)
        .then((q) => {
          if (alive) setQuote(q);
        })
        .catch(() => {
          if (alive) setQuote(null);
        });
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [trading, asset, side, mode, activeValue, validInput, toleranceBps, referencePrice, settled]);

  const position = account.positions.find((p) => p.asset === assetId);

  // Keep the receipt visible; reset to idle when the user changes inputs.
  useEffect(() => {
    setSettled((s) => (s ? null : s));
  }, [unitsText, gusdText, side, toleranceBps]);

  // The wallet context row — what this side draws on, with MAX where the
  // basis can consume it: the whole balance in money-first buys, the
  // whole holding in size-first sells. A buy in units mode or a sell in
  // money-first mode shows the figure without a key (there is no exact
  // inversion to fill).
  const context =
    connected && side === "buy"
      ? { label: `balance ${fmtGusdLedger(account.gUsdBalance)} gUSD`, max: account.gUsdBalance, canMax: mode === "gusd" }
      : connected && position && position.size > 0
        ? { label: `holding ${fmtUnits(position.size)} ${assetId}`, max: Math.floor(position.size * 1e6) / 1e6, canMax: mode === "units" }
        : null;

  // The availability gate, in the design system's amber voice. Undefined
  // is "still checking", null is "the chain has no such market".
  let gate: string | null = null;
  if (availability === null) {
    gate = "This market isn't registered onchain yet — orders open when the asset settles.";
  } else if (availability) {
    if (side === "sell" && !availability.poolRegistered) {
      gate = "No secondary depth yet — sells open when the pool holds liquidity.";
    } else if (side === "buy" && !availability.issuanceEnabled && !availability.poolRegistered) {
      gate = "Neither issuance nor a market is open for this asset yet — orders wait for the operator.";
    } else if (side === "sell" && quote === null && referencePrice !== null && validInput) {
      // Registered but unquotable — at genesis that's an empty pool. The
      // dashes say "no numbers"; this says why.
      gate = "Nothing to quote this sell against yet — the pool holds no depth.";
    }
  }

  async function onSubmit() {
    if (!asset) return;
    if (!connected) {
      setError("Connect a wallet to trade — nothing signs without one.");
      return;
    }
    if (!validInput) {
      setError(mode === "gusd" ? "Enter a gUSD amount greater than zero." : "Enter a size greater than zero.");
      return;
    }
    if (gate) return;
    setError(null);
    try {
      const request: TradeRequest =
        mode === "gusd"
          ? { asset, side, basis: "gusd", gusd: activeValue, toleranceBps }
          : { asset, side, basis: "units", size: activeValue, toleranceBps };
      const record = await trading.execute(request);
      setSettled(record);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The order didn't go through. Try again in a moment.");
    }
  }

  // Ledger terms, each printed at 4 decimals so the rows visibly close.
  // Every figure is anchored arithmetic off the API price — the same
  // reference the desk hero and the chart stand on — never a
  // quote-derived all-in number, which would read as a second, competing
  // truth a few decimals away. The ~ rows are the typed order run
  // through the anchor; the bound rows take the chain oracle when it
  // moves the bound in the user's favor (a lower oracle lifts a receive
  // floor, a higher one raises a pay cap) and stay on the anchor
  // otherwise. Execution signs its own fresh bounds at submit; a gap
  // between this ledger and the fill is slippage, not a second price.

  // The anchor and its oracle-refined bounds. Null anchor → no rows, the
  // dashes speak.
  const oraclePrice = availability?.oraclePrice ?? null;

  let ledgerRows: ReactNode = null;
  if (referencePrice !== null && referencePrice > 0 && validInput && quote !== null) {
    const g = activeValue;
    // Bounds: the oracle enters only on its favorable side — a lower
    // oracle lifts a receive floor, a higher one raises a pay cap.
    const minBoundPrice =
      oraclePrice !== null && oraclePrice <= referencePrice ? oraclePrice : referencePrice;
    const maxBoundPrice =
      oraclePrice !== null && oraclePrice >= referencePrice ? oraclePrice : referencePrice;
    if (side === "buy") {
      ledgerRows =
        mode === "gusd" ? (
          <>
            <LedgerRow
              label="You receive"
              value={`~${fmtUnitsLedger(g / referencePrice)} ${assetId}`}
              strong
            />
            <LedgerRow
              label="Min you receive"
              value={`${fmtUnitsLedger(g / minBoundPrice)} ${assetId}`}
            />
            <LedgerRow label="Max you pay" value={`${fmtGusdLedger(g)} gUSD`} />
          </>
        ) : (
          <>
            <LedgerRow
              label="You pay"
              value={`~${fmtGusdLedger(g * referencePrice)} gUSD`}
              strong
            />
            <LedgerRow label="Max you pay" value={`${fmtGusdLedger(g * maxBoundPrice)} gUSD`} />
          </>
        );
    } else {
      ledgerRows =
        mode === "gusd" ? (
          <>
            <LedgerRow
              label="You sell"
              value={`~${fmtUnitsLedger(g / referencePrice)} ${assetId}`}
              strong
            />
            <LedgerRow
              label="Max you pay"
              value={`${fmtUnitsLedger(g / maxBoundPrice)} ${assetId}`}
            />
            <LedgerRow label="Min you receive" value={`${fmtGusdLedger(g)} gUSD`} />
          </>
        ) : (
          <>
            <LedgerRow
              label="You receive"
              value={`~${fmtGusdLedger(g * referencePrice)} gUSD`}
              strong
            />
            <LedgerRow
              label="Min you receive"
              value={`${fmtGusdLedger(g * minBoundPrice)} gUSD`}
            />
          </>
        );
    }
  }

  return (
    <div className="space-y-3.5 p-3.5">
      {/* Side switch — the active side fills in its direction color */}
      <div className="grid grid-cols-2 border border-rule-strong" role="group" aria-label="Trade side">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={side === s}
            onClick={() => setSide(s)}
            className={`slug py-2.5 transition-colors ${
              side === s
                ? s === "buy"
                  ? "rev-g"
                  : "rev-d"
                : "text-dim hover:text-data"
            }`}
          >
            <span aria-hidden className="mr-1.5 text-[9px]">{s === "buy" ? "▲" : "▼"}</span>
            {s === "buy" ? "Buy" : "Sell"} <Pair id={assetId} />
          </button>
        ))}
      </div>

      {/* Basis — what the input means. gUSD-first is the default flow;
          size-first stays one toggle away. */}
      <div className="flex items-baseline justify-between">
        <span className="slug text-dim">
          {mode === "gusd" ? (side === "buy" ? "Spend · gUSD" : "Receive · gUSD") : "Size · units"}
        </span>
        <div className="flex items-baseline" role="group" aria-label="Order basis">
          {(["gusd", "units"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={`num border-b px-2 py-0.5 text-[11px] transition-colors ${
                mode === m
                  ? "border-amber text-amber"
                  : "border-transparent text-dim hover:text-data"
              }`}
            >
              {m === "gusd" ? "gUSD" : "UNITS"}
            </button>
          ))}
        </div>
      </div>

      {context && (
        <div className="flex items-baseline justify-between">
          <span className="num text-[10.5px] text-dim">{context.label}</span>
          <button
            type="button"
            onClick={() => setActiveText(maxText(context.max))}
            disabled={!context.canMax || context.max <= 0}
            className="num border-b border-rule px-1.5 text-[10.5px] text-dim transition-colors hover:text-amber disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-dim"
          >
            MAX
          </button>
        </div>
      )}

      <div className="flex items-stretch border border-rule-strong bg-ground focus-within:border-amber">
        <input
          type="text"
          inputMode="decimal"
          value={activeText}
          onChange={(e) => setActiveText(e.target.value.replace(/[^0-9.]/g, ""))}
          aria-label={
            mode === "gusd"
              ? side === "buy"
                ? "Order spend in gUSD"
                : "Order proceeds in gUSD"
              : `Order size in ${assetId} units`
          }
          className="num w-full bg-transparent px-3 py-2.5 text-[15px] text-data outline-none"
        />
        <div className="flex items-stretch border-l border-rule">
          {(mode === "gusd" ? GUSD_PRESETS : UNIT_PRESETS).map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setActiveText(String(preset))}
              className="num border-l border-rule px-2.5 text-[11px] text-dim first:border-l-0 hover:text-amber"
            >
              {preset}
            </button>
          ))}
        </div>
      </div>

      {/* Slippage tolerance — the bound each cell signs: a spend cap for
          size-first buys, a receipt floor everywhere else. */}
      <div className="flex items-baseline justify-between">
        <span className="slug text-dim">
          {side === "buy" && mode === "units" ? "Max spend slip" : "Min receipt slip"}
        </span>
        <div className="flex items-baseline" role="group" aria-label="Slippage tolerance">
          {TOLERANCE_PRESETS_BPS.map((bps) => (
            <button
              key={bps}
              type="button"
              aria-pressed={toleranceBps === bps}
              onClick={() => setToleranceBps(bps)}
              className={`num border-b px-2 py-0.5 text-[11px] transition-colors ${
                toleranceBps === bps
                  ? "border-amber text-amber"
                  : "border-transparent text-dim hover:text-data"
              }`}
            >
              {bps / 100}%
            </button>
          ))}
        </div>
      </div>

      {/* The ticket's ledger — one price, the API's. The Price row
          restates it; every other row is the typed order run through
          that anchor, with the bounds oracle-refined in the user's
          favor. Rows render from the anchor the moment the input moves;
          they go to dashes only when the anchor is missing or the chain
          says it can't price the order at all. */}
      <dl className="space-y-1.5 text-[12.5px]">
        <LedgerRow
          label="Price"
          value={referencePrice !== null && referencePrice > 0 ? fmtGusdLedger(referencePrice) : "—"}
        />
        {ledgerRows ?? (
          <LedgerRow
            label={
              side === "buy"
                ? mode === "gusd"
                  ? "You receive"
                  : "You pay"
                : mode === "gusd"
                  ? "You sell"
                  : "You receive"
            }
            value="—"
            strong
          />
        )}
      </dl>

      {availability === undefined && (
        <p className="text-[11.5px] leading-relaxed text-dim">
          Checking the market onchain…
        </p>
      )}

      <WalletlessNote />

      {gate && (
        <p className="border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
          {gate}
        </p>
      )}

      {referencePrice === null && (
        <p className="text-[11.5px] leading-relaxed text-dim">
          No reference price yet — orders open when the feed asserts one.
        </p>
      )}

      {!connected && (
        <p className="text-[11.5px] leading-relaxed text-dim">
          Connect a wallet to trade — nothing signs without one.
        </p>
      )}

      {error && (
        <p className="border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
          {error}
        </p>
      )}

      {(active ?? settled) && <ActionStatus record={(active ?? settled) as ActionRecord} />}

      <button
        type="button"
        onClick={onSubmit}
        disabled={
          active !== null || !validInput || !quote || gate !== null || referencePrice === null
        }
        className={`slug w-full py-2.5 text-rev-fg transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${
          side === "buy" ? "rev-g hover:opacity-90" : "rev-d hover:opacity-90"
        }`}
      >
        {active !== null ? (
          "Placing…"
        ) : (
          <>
            {side === "buy" ? "Buy" : "Sell"} <Pair id={assetId} />
          </>
        )}
      </button>
    </div>
  );
}

function LedgerRow({
  label,
  value,
  meta,
  strong,
}: {
  label: string;
  value: string;
  meta?: string;
  strong?: boolean;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <dt className={`slug ${strong ? "text-bright" : "text-dim"}`}>{label}</dt>
        <dd className={`num ${strong ? "text-[14px] font-bold text-bright" : "text-[12.5px] text-data"}`}>
          {value}
        </dd>
      </div>
      {meta && <div className="num text-right text-[10px] leading-tight text-dim">{meta}</div>}
    </div>
  );
}
