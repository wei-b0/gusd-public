"use client";

/**
 * AddressRow — one contract-address ledger row with the copy flash. The
 * row is the deployment record's readout: slug label left, tabular address
 * (truncated per fmtAddress, full value on the title) right, COPY key
 * flashing COPIED — the WalletRow grammar, reused for the record.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { fmtAddress } from "@/domain/format";

export function AddressRow({
  label,
  address,
  note,
}: {
  label: ReactNode;
  address: string;
  note?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function copy() {
    try {
      void navigator.clipboard.writeText(address).then(
        () => {
          if (timer.current) clearTimeout(timer.current);
          setCopied(true);
          timer.current = setTimeout(() => setCopied(false), 1_600);
        },
        () => {},
      );
    } catch {
      // Clipboard unavailable (insecure context) — the address stays readable.
    }
  }

  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-rule py-1.5 last:border-b-0 last:pb-0">
      <dt className="slug shrink-0 text-dim">
        {label}
        {note ? <span className="ml-2 text-[9px] font-normal">{note}</span> : null}
      </dt>
      <dd className="flex items-baseline gap-2">
        <span className="num text-[12.5px] text-data" title={address}>
          {fmtAddress(address)}
        </span>
        <button
          type="button"
          onClick={copy}
          className="slug text-dim transition-colors hover:text-amber"
        >
          {copied ? "COPIED" : "COPY"}
        </button>
      </dd>
    </div>
  );
}