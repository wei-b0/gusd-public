"use client";

/**
 * OrderSlip — the trade furniture inside the Trade panel. Quotes come from
 * the router stack itself (the contract's own quoteIssue and the
 * hook-aware V4Quoter — quote == execute); execution runs through the
 * action runner, so every submit walks approval → signature → confirmation
 * as one visible action. The reference price stays the one price the desk
 * displays; when the data layer asserts none, the slip goes dormant rather
 * than quoting against nothing. The quote ledger prints at ledger grade
 * (fixed 4 decimals) so its rows visibly close.
 *
 * Unavailable markets speak in place: an unregistered asset, a closed
 * issuance, or an empty pool each get their own honest voice — never a
 * silent dead button.
 */

import { useEffect, useState } from "react";
import type { ActionRecord } from "@/domain/actions";
import type { TradeAvailability, TradeQuote, TradeSide } from "@/domain/types";
import { parseAssetId } from "@/domain/types";
import { fmtGusdLedger, fmtUnits } from "@/domain/format";
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

export function OrderSlip({ assetId, referencePrice }: OrderSlipProps) {
  const { trading } = useServices();
  const account = useAccount();
  const session = useWalletSession();
  const active = useActiveAction("trade");
  const [side, setSide] = useState<TradeSide>("buy");
  const [sizeText, setSizeText] = useState("1");
  const [toleranceBps, setToleranceBps] = useState(DEFAULT_TOLERANCE_BPS);
  const [availability, setAvailability] = useState<TradeAvailability | null | undefined>(undefined);
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [settled, setSettled] = useState<ActionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const size = Number(sizeText);
  const validSize = Number.isFinite(size) && size > 0;
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
  // order lands (the balances behind presets and caps moved).
  useEffect(() => {
    if (!asset || !validSize || referencePrice === null) {
      setQuote(null);
      return;
    }
    let alive = true;
    setQuote(null);
    const timer = setTimeout(() => {
      trading
        .quote({ asset, side, size, toleranceBps })
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
  }, [trading, asset, side, size, validSize, toleranceBps, referencePrice, settled]);

  const position = account.positions.find((p) => p.asset === assetId);

  // Keep the receipt visible; reset to idle when the user changes inputs.
  useEffect(() => {
    setSettled((s) => (s ? null : s));
  }, [sizeText, side, toleranceBps]);

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
    }
  }

  async function onSubmit() {
    if (!asset) return;
    if (!connected) {
      setError("Connect a wallet to trade — nothing signs without one.");
      return;
    }
    if (!validSize) {
      setError("Enter a size greater than zero.");
      return;
    }
    if (gate) return;
    setError(null);
    try {
      const record = await trading.execute({ asset, side, size, toleranceBps });
      setSettled(record);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The order didn't go through. Try again in a moment.");
    }
  }

  // Ledger terms, each printed at 4 decimals so the rows visibly close.
  // No quote → no ledger rows: sizing an order against nothing would
  // fabricate the one number the ledger exists to show.
  const feeTotal = quote ? quote.fees.protocol + quote.fees.issuance : null;

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

      <div className="flex items-baseline justify-between">
        <span className="slug text-dim">Size · units</span>
        {connected && position && position.size > 0 ? (
          <span className="num text-[10.5px] text-dim">
            holding {fmtUnits(position.size)}
          </span>
        ) : null}
      </div>
      <div className="flex items-stretch border border-rule-strong bg-ground focus-within:border-amber">
        <input
          type="text"
          inputMode="decimal"
          value={sizeText}
          onChange={(e) => setSizeText(e.target.value.replace(/[^0-9.]/g, ""))}
          aria-label={`Order size in ${assetId} units`}
          className="num w-full bg-transparent px-3 py-2.5 text-[15px] text-data outline-none"
        />
        <div className="flex items-stretch border-l border-rule">
          {[1, 4, 10].map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setSizeText(String(preset))}
              className="num border-l border-rule px-2.5 text-[11px] text-dim first:border-l-0 hover:text-amber"
            >
              {preset}
            </button>
          ))}
        </div>
      </div>

      {/* Slippage tolerance — buys sign a spend cap, sells a payout floor */}
      <div className="flex items-baseline justify-between">
        <span className="slug text-dim">{side === "buy" ? "Max spend slip" : "Min receipt slip"}</span>
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

      {/* Quote ledger — size × est. price ≈ the cap, with the fee stack called out */}
      <dl className="space-y-1.5 text-[12.5px]">
        <LedgerRow
          label="Est. price"
          value={quote ? fmtGusdLedger(quote.price) : "—"}
        />
        {quote && side === "buy" && quote.legs.pool > 0 && quote.legs.issuance > 0 && (
          <LedgerRow
            label="Fill split"
            value={`${fmtUnits(quote.legs.pool)} market + ${fmtUnits(quote.legs.issuance)} issuance`}
          />
        )}
        {quote && side === "buy" && quote.legs.pool === 0 && (
          <LedgerRow label="Source" value="primary issuance" />
        )}
        {feeTotal !== null && (
          <LedgerRow label="Est. fee · incl." value={fmtGusdLedger(feeTotal)} />
        )}
        <LedgerRow
          label={side === "buy" ? "You pay" : "You receive"}
          value={
            quote
              ? `${fmtGusdLedger(side === "buy" ? quote.maxPaid : quote.minOut)} gUSD`
              : "—"
          }
          strong
        />
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
          active !== null || !validSize || quote === null || gate !== null || referencePrice === null
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

      <p className="num text-[10px] leading-relaxed text-dim">
        {availability
          ? `Fees ${(availability.poolFeeBps / 100).toFixed(2)}% LP · ${(availability.hookFeeBps / 100).toFixed(2)}% protocol · settles in gUSD`
          : "Settles in gUSD"}
      </p>
    </div>
  );
}

function LedgerRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className={`slug ${strong ? "text-bright" : "text-dim"}`}>{label}</dt>
      <dd className={`num ${strong ? "text-[14px] font-bold text-bright" : "text-[12.5px] text-data"}`}>
        {value}
      </dd>
    </div>
  );
}
