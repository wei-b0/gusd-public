"use client";

/**
 * OrderSlip — the trade furniture inside the Trade panel. Quotes and fills
 * come from the TradingPort adapter; trading requires a connection. The
 * quote ledger prints at ledger grade (fixed 4 decimals) so its rows
 * visibly sum.
 */

import { useEffect, useMemo, useState } from "react";
import type { TradeReceipt, TradeSide } from "@/domain/types";
import { parseAssetId } from "@/domain/types";
import { fmtGusdLedger, fmtNotional, fmtStamp, fmtUnits } from "@/domain/format";
import { Pair } from "@/components/ui/pair";
import { useAccount, useServices } from "@/data/services";

export interface OrderSlipProps {
  assetId: string;
  marketPrice: number;
}

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "filled"; receipt: TradeReceipt }
  | { kind: "error"; message: string };

export function OrderSlip({ assetId, marketPrice }: OrderSlipProps) {
  const { trading } = useServices();
  const account = useAccount();
  const [side, setSide] = useState<TradeSide>("buy");
  const [sizeText, setSizeText] = useState("1");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const size = Number(sizeText);
  const validSize = Number.isFinite(size) && size > 0;

  const asset = parseAssetId(assetId);
  const quote = useMemo(
    () => (asset && validSize ? trading.quote({ asset, side, size }) : null),
    [trading, asset, side, size, validSize],
  );

  const position = account.positions.find((p) => p.asset === assetId);

  // Keep the receipt visible; reset to idle when the user changes inputs.
  useEffect(() => {
    setStatus((s) => (s.kind === "filled" ? { kind: "idle" } : s));
  }, [sizeText, side]);

  async function onSubmit() {
    if (!asset) return;
    if (!account.connected) {
      setStatus({ kind: "error", message: "Connect to trade — demo capital is provided once connected." });
      return;
    }
    if (!validSize) {
      setStatus({ kind: "error", message: "Enter a size greater than zero." });
      return;
    }
    setStatus({ kind: "submitting" });
    try {
      const receipt = await trading.execute({ asset, side, size });
      setStatus({ kind: "filled", receipt });
    } catch {
      setStatus({ kind: "error", message: "The fill failed. Adjust the order and try again." });
    }
  }

  // Ledger terms, each printed at 4 decimals so the rows visibly close.
  const impactUsd = quote ? size * (quote.price - marketPrice) : null;
  const total = quote?.notional ?? (validSize ? size * marketPrice : null);

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
        {account.connected && position && position.size > 0 ? (
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

      {/* Quote ledger — the rows sum: price × size ± impact + fee = total, in gUSD */}
      <dl className="space-y-1.5 text-[12.5px]">
        <LedgerRow label="Est. price" value={quote ? fmtGusdLedger(quote.price) : fmtGusdLedger(marketPrice)} />
        {impactUsd != null && (
          <LedgerRow
            label="Est. impact"
            value={`${impactUsd >= 0 ? "+" : "−"}${fmtGusdLedger(Math.abs(impactUsd))}`}
          />
        )}
        <LedgerRow label="Est. fee" value={quote ? fmtGusdLedger(quote.feeUsd) : "—"} />
        <LedgerRow
          label={side === "buy" ? "You pay" : "You receive"}
          value={total != null ? `${fmtGusdLedger(total)} gUSD` : "—"}
          strong
        />
      </dl>

      {!account.connected && (
        <p className="text-[11.5px] leading-relaxed text-dim">
          Connect to trade — demo capital is provided once connected.
        </p>
      )}

      {status.kind === "error" && (
        <p className="border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
          {status.message}
        </p>
      )}

      {status.kind === "filled" && (
        <div className="border border-rule-strong bg-panel-deep p-2.5">
          <p className="rev slug mb-2 inline-block px-1.5 py-0.5 text-[9.5px]">Filled</p>
          <p className="num text-[11.5px] leading-relaxed text-data">
            {status.receipt.side === "buy" ? "Bought" : "Sold"} {fmtUnits(status.receipt.size)}{" "}
            <Pair id={status.receipt.asset} /> @ {fmtGusdLedger(status.receipt.fillPrice)} ·{" "}
            {fmtNotional(status.receipt.notional)} gUSD · {fmtStamp(status.receipt.t)}
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={onSubmit}
        disabled={status.kind === "submitting" || !validSize}
        className={`slug w-full py-2.5 text-rev-fg transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${
          side === "buy" ? "rev-g hover:opacity-90" : "rev-d hover:opacity-90"
        }`}
      >
        {status.kind === "submitting" ? (
          "Placing…"
        ) : (
          <>
            {side === "buy" ? "Buy" : "Sell"} <Pair id={assetId} />
          </>
        )}
      </button>

      <p className="num text-[10px] leading-relaxed text-dim">
        Fee 6 bps · impact ~3 bps per unit · quoted in gUSD
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
