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
 * limits rather than the displayed numbers. The ledger rows render from
 * the live quote — the same pricing path execution will sign — so the
 * ticket and the fill speak one truth: buys price the signed spend cap
 * (maxPaid, refundable on exact-out) and their units floor (minSize on
 * money-first), sells price the signed payout floor (minOut) over the
 * units actually sold. While the quote is in flight the rows fall back
 * to anchor arithmetic off the API price — the same reference the desk
 * hero and the chart stand on — display only; the submit button stays
 * gated on the quote itself, and a gap between the fallback ledger and
 * the fill is slippage, never a second displayed price. The chain oracle
 * refines the fallback bounds only on their favorable side: a lower
 * oracle lifts a receive floor, a higher one raises a pay cap. When the
 * data layer asserts no reference price, the slip goes dormant rather
 * than quoting against nothing.
 *
 * Unavailable markets speak in place: an unregistered asset, a closed
 * issuance, or an empty pool each get their own honest voice — never a
 * silent dead button.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ActionRecord } from "@/domain/actions";
import type { TradeAvailability, TradeQuote, TradeRequest, TradeSide } from "@/domain/types";
import { parseAssetId } from "@/domain/types";
import { fmtGusdLedger, fmtUnitsLedger, fmtUnitsMax } from "@/domain/format";
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

/** Percent-of-basis presets — fractions of the same base MAX fills,
 *  wherever a concrete base exists (see `context`). */
const PRESETS = [0.1, 0.5, 1] as const;

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
  // The MAX click on a money-first sell quotes the full holding live —
  // busy state + request counter discard stale responses (same debounce
  // doctrine as the quote effect).
  const [maxBusy, setMaxBusy] = useState(false);
  const maxReq = useRef(0);

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

  // Keep the receipt visible; reset to idle and clear a stale pre-flight
// refusal when the user changes inputs.
  useEffect(() => {
    setSettled((s) => (s ? null : s));
    setError(null);
  }, [unitsText, gusdText, side, toleranceBps]);

  // The wallet context row — what this side draws on, with MAX wherever a
  // concrete figure can fill the input: the whole balance in money-first
  // buys, the whole holding in size-first sells — and, on money-first
  // sells, the holding quoted live with its net proceeds filling the
  // input. The label prints the 6-dec grain so a typed-back figure
  // visibly differs from the exact holding.
  const context =
    connected && side === "buy"
      ? { label: `balance ${fmtGusdLedger(account.gUsdBalance)} gUSD`, max: account.gUsdBalance, canMax: mode === "gusd" }
      : connected && position && position.size > 0
        ? { label: `holding ${fmtUnitsMax(position.size)} ${assetId}`, max: Math.floor(position.size * 1e6) / 1e6, canMax: true }
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

  // Presets fill the input with a fraction of the same base MAX uses.
  // Everywhere the input IS the balance/holding (money-first buys,
  // size-first sells) that's the direct figure, floored to the 6-dec
  // grain by fmtUnitsMax. On money-first sells the input is the proceeds,
  // so the click quotes that fraction of the holding and fills the net
  // proceeds — the follow-up re-quote then derives units within the
  // holding, so its pre-flight passes on its own. MAX is the 100% preset.
  async function applyPreset(frac: number) {
    if (!asset || context === null) return;
    if (side === "sell" && mode === "gusd") {
      const req = ++maxReq.current;
      setMaxBusy(true);
      try {
        const q = await trading.quote({
          asset,
          side: "sell",
          basis: "units",
          size: Math.floor(context.max * frac * 1e6) / 1e6,
          toleranceBps,
        });
        if (q !== null && maxReq.current === req) setGusdText(fmtUnitsMax(q.notional));
      } catch {
        // The chain can't price the holding — leave the input alone.
      } finally {
        if (maxReq.current === req) setMaxBusy(false);
      }
      return;
    }
    setActiveText(fmtUnitsMax(context.max * frac));
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
  // Source of truth is the live quote — the same pricing path execution
  // signs at submit — so the ticket and the fill can't disagree: buys
  // price the signed spend cap (maxPaid; the typed spend itself on
  // money-first, exact-pull with no refund) and their units floor
  // (minSize on money-first), sells price the signed payout floor
  // (minOut) over the units actually sold. While the quote is in flight
  // the rows fall back to anchor arithmetic off the API price — the same
  // reference the desk hero and the chart stand on — with the bounds
  // oracle-refined on their favorable side (a lower oracle lifts a
  // receive floor, a higher one raises a pay cap). A gap between the
  // fallback ledger and the fill is slippage, not a second price; submit
  // stays gated on the quote.

  // The anchor's oracle-refinement input. Null when the API publishes no
  // oracle figure — the fallback rows then stand on the anchor alone.
  const oraclePrice = availability?.oraclePrice ?? null;

  let ledgerRows: ReactNode = null;
  if (quote !== null && quote !== undefined && quote.asset === asset && quote.side === side && validInput) {
    if (side === "buy") {
      ledgerRows =
        mode === "gusd" ? (
          <>
            <LedgerRow
              label="You receive"
              value={`~${fmtUnitsLedger(quote.size)} ${assetId}`}
              strong
            />
            <LedgerRow
              label="Min you receive"
              value={`${fmtUnitsLedger(quote.minSize)} ${assetId}`}
            />
            <LedgerRow label="Max you pay" value={`${fmtGusdLedger(quote.maxPaid)} gUSD`} />
          </>
        ) : (
          <>
            <LedgerRow
              label="You pay"
              value={`~${fmtGusdLedger(quote.notional)} gUSD`}
              strong
            />
            <LedgerRow label="Max you pay" value={`${fmtGusdLedger(quote.maxPaid)} gUSD`} />
          </>
        );
    } else {
      ledgerRows =
        mode === "gusd" ? (
          <>
            <LedgerRow
              label="You sell"
              value={`~${fmtUnitsLedger(quote.size)} ${assetId}`}
              strong
            />
            <LedgerRow label="Min you receive" value={`${fmtGusdLedger(quote.minOut)} gUSD`} />
          </>
        ) : (
          <>
            <LedgerRow
              label="You receive"
              value={`~${fmtGusdLedger(quote.notional)} gUSD`}
              strong
            />
            <LedgerRow
              label="Min you receive"
              value={`${fmtGusdLedger(quote.minOut)} gUSD`}
            />
          </>
        );
    }
  } else if (quote === undefined && referencePrice !== null && referencePrice > 0 && validInput) {
    // Fallback while the quote is in flight: anchor arithmetic off the API
    // price. Display only — the submit button stays gated on the quote.
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
              value={`${fmtUnitsLedger(g / maxBoundPrice)} ${assetId}`}
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
            onClick={() => void applyPreset(1)}
            disabled={!context.canMax || context.max <= 0 || maxBusy}
            className="num border-b border-rule px-1.5 text-[10.5px] text-dim transition-colors hover:text-amber disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-dim"
          >
            {maxBusy ? "…" : "MAX"}
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
          {PRESETS.map((frac) => (
            <button
              key={frac}
              type="button"
              onClick={() => void applyPreset(frac)}
              disabled={!context || !context.canMax || context.max <= 0 || maxBusy}
              className="num border-l border-rule px-2.5 text-[11px] text-dim first:border-l-0 hover:text-amber disabled:cursor-not-allowed disabled:opacity-40"
            >
              {frac * 100}%
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
          restates the anchor; the term rows render from the live quote
          (execution's own pricing path) the moment it lands, falling
          back to anchor arithmetic only while the quote is in flight.
          They go to dashes when the anchor is missing or the chain says
          it can't price the order at all. */}
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
