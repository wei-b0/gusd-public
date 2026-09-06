import type { ReactNode } from "react";

/**
 * The quote-ledger row — label in slug ink, value in tabular figures, the
 * strong variant for the row the decision hangs on ("You receive"). Shared
 * by the mint desk and the cross-chain funding panel, whose ledgers speak
 * the same contract-preview grammar.
 */
export function LedgerRow({
  label,
  value,
  strong,
}: {
  label: ReactNode;
  value: ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className={`slug ${strong ? "text-bright" : "text-dim"}`}>{label}</dt>
      <dd className={`num ${strong ? "text-[14px] font-bold text-bright" : "text-[12.5px] text-data"}`}>
        {value}
      </dd>
    </div>
  );
}
