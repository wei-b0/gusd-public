"use client";

/**
 * TxReceipt — the receipt grammar for single chain transactions: pending
 * states read as amber system speech with the hash, confirmation wears
 * reverse video (the "Filled" pattern), and every terminal failure speaks
 * in the amber box, product-voiced, never a raw error string. Red stays
 * quarantined; a revert is amber, not shame.
 *
 * Its live producer is TxDevPanel below, gated behind
 * NEXT_PUBLIC_ENABLE_TX_DEV. Product surfaces render actions — approval
 * plus call, however many transactions — through ActionStatus, which
 * prints the same grammar per step; this component stays the dev panel's
 * single-transaction view.
 */

import { useState } from "react";
import type { TxRecord, TxStatus } from "@/domain/types";
import { fmtHash } from "@/domain/format";
import { TuiPanel } from "@/components/ui/panel";
import { useServices, useTransactions, useWalletSession } from "@/data/services";
import { selfTransferSpec } from "@/data/web3/self-transfer";

export function TxReceipt({ tx }: { tx: TxRecord }) {
  const confirmed = tx.status === "confirmed";
  const reverted = tx.status === "reverted";
  const failed = tx.status === "failed" || tx.status === "rejected";
  const inFlight = !confirmed && !reverted && !failed;

  return (
    <div aria-live="polite" className="border-b border-rule px-3 py-2 last:border-b-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="slug text-dim">{tx.kind}</span>
        {confirmed && (
          <span className="rev slug inline-block px-1.5 py-0.5 text-[9.5px]">Confirmed</span>
        )}
        {reverted && (
          <span className="slug inline-block border border-amber/40 px-1.5 py-0.5 text-[9.5px] text-amber">
            Reverted
          </span>
        )}
        {failed && (
          <span className="slug inline-block border border-amber/40 px-1.5 py-0.5 text-[9.5px] text-amber">
            {tx.status === "rejected" ? "Declined" : "Failed"}
          </span>
        )}
        {inFlight && <Tag status={tx.status} />}
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="num text-[11px] text-dim">{tx.hash ? fmtHash(tx.hash) : "—"}</span>
        {confirmed && <span className="num text-[11px] text-dim">block {tx.blockNumber ?? "—"}</span>}
        {reverted && <span className="num text-[11px] text-dim">block {tx.blockNumber ?? "—"}</span>}
        {inFlight && tx.status !== "signing" && (
          <span className="slug text-dim">confirming…</span>
        )}
      </div>
      {tx.error && (
        <p className="mt-1.5 border border-amber/40 bg-amber/10 p-2 text-[11px] leading-relaxed text-amber">
          {tx.error}
        </p>
      )}
    </div>
  );
}

/** In-flight tag: amber system speech, no box yet. */
function Tag({ status }: { status: TxStatus }) {
  const label = status === "signing" ? "Signing" : "Submitted";
  return <span className="slug text-[9.5px] text-amber">{label}</span>;
}

/**
 * TxDevPanel — the dev-only producer that exercises the full lifecycle. Set
 * NEXT_PUBLIC_ENABLE_TX_DEV=1 to mount it under the page body; it is never
 * part of the product shell.
 */
const TX_DEV = process.env.NEXT_PUBLIC_ENABLE_TX_DEV === "1";

export function TxDevPanel() {
  if (!TX_DEV) return null;
  return <TxDevPanelBody />;
}

function TxDevPanelBody() {
  const { tx } = useServices();
  const session = useWalletSession();
  const records = useTransactions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await tx.run(selfTransferSpec());
    } catch (err) {
      // Pre-flight refusals (no wallet, wrong network) throw product-voiced
      // messages; everything else already landed as a terminal record.
      setError(err instanceof Error ? err.message : "The transaction didn't start.");
    } finally {
      setBusy(false);
    }
  }

  const connected = session.status === "connected";

  return (
    <section className="mx-auto w-full max-w-360 px-3 pb-4 md:px-5">
      <TuiPanel
        no="99"
        title="Transactions"
        meta="dev"
        right={
          <button
            type="button"
            onClick={send}
            disabled={!connected || busy}
            className="rev slug px-2 py-0.5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Signing…" : "Send self-tx"}
          </button>
        }
      >
        <div className="bg-panel-deep">
          {error && (
            <p
              role="alert"
              className="border-b border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber"
            >
              {error}
            </p>
          )}
          {records.length === 0 ? (
            <p className="slug px-3 py-3 text-dim">
              {connected ? "No transactions yet." : "Connect a wallet to send."}
            </p>
          ) : (
            records.map((record) => <TxReceipt key={record.id} tx={record} />)
          )}
        </div>
      </TuiPanel>
    </section>
  );
}
