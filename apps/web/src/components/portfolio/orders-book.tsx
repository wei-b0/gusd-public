"use client";

/**
 * Portfolio armed-orders book — every armed order across all markets, one
 * place, with per-row Cancel. Order reads come from `listPendingOrders()`
 * via the portfolio book hook (indexer-first, session fallback); null = the
 * read failed — never "nothing armed".
 */

import { useState } from "react";
import Link from "next/link";
import type { ActionRecord } from "@/domain/actions";
import type { PerpOrderKind } from "@/domain/types";
import { pairName } from "@/domain/types";
import { fmtAge, fmtGusdLedger, fmtGusdPrecise } from "@/domain/format";
import { ActionStatus } from "@/components/ui/action-status";
import { TuiPanel } from "@/components/ui/panel";
import { useActiveAction, useServices } from "@/data/services";
import type { PerpPortfolioBook } from "@/data/web3/perps/use-perp-portfolio";

const KIND_LABEL: Record<PerpOrderKind, string> = {
  open: "Open",
  close: "Close",
  "stop-loss": "Stop-loss",
  "take-profit": "Take-profit",
};

export function OrdersBook({ book, no }: {
  book: PerpPortfolioBook;
  no: string;
}) {
  const { perp } = useServices();
  const active = useActiveAction("perp-cancel");
  const [settled, setSettled] = useState<ActionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ordersState = book.ordersLoaded ? (book.orders === null ? "failed" : "live") : "reading";
  const orders = book.orders;

  async function cancel(orderId: number) {
    if (active !== null) return;
    setError(null);
    try {
      const record = await perp.cancelOrder(orderId);
      setSettled(record);
      book.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The cancel didn't go through. Try again in a moment.");
    }
  }

  return (
    <TuiPanel
      no={no}
      title="Armed orders"
      meta={ordersState === "live" ? `${book.orders?.length ?? 0} pending` : undefined}
    >
      <div className="px-3.5 pb-1 pt-2.5 text-[11.5px] leading-relaxed text-dim">
        Orders lock their collateral and the execution fee up front, then fill at the next settlement price inside
        their limit — they stay armed until they fill or you cancel them.
      </div>
      {!book.connected ? (
        <p className="px-3.5 pb-3.5 text-[11.5px] leading-relaxed text-dim">Connect a wallet to see your orders.</p>
      ) : ordersState === "reading" ? (
        <p className="px-3.5 pb-3.5 text-[11.5px] leading-relaxed text-dim">Reading orders…</p>
      ) : ordersState === "failed" ? (
        <div className="flex items-center justify-between gap-3 px-3.5 pb-3.5">
          <p className="text-[11.5px] leading-relaxed text-amber">
            Couldn't read your armed orders — the book read failed. Your orders are unaffected.
          </p>
          <button
            type="button"
            onClick={book.refresh}
            className="slug shrink-0 border border-rule-strong px-2.5 py-0.5 text-dim transition-colors hover:text-bright"
          >
            Retry
          </button>
        </div>
      ) : orders === null || orders.length === 0 ? (
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
                <Link
                  href={`/perps/${o.asset}`}
                  className="num text-[11px] font-bold text-data hover:text-bright"
                >
                  {pairName(o.asset)}
                </Link>{" "}
                <span className={o.side === "long" ? "text-up" : "text-down"}>{KIND_LABEL[o.kind]}</span>{" "}
                {o.kind === "open" ? (
                  <>
                    {fmtGusdLedger(o.sizeUsd)} @ limit {fmtGusdPrecise(o.price)} · locked {fmtGusdLedger(o.collateral)}{" "}
                    gUSD
                  </>
                ) : o.kind === "close" ? (
                  <>
                    close {fmtGusdLedger(o.sizeUsd)} @ limit {fmtGusdPrecise(o.price)}
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