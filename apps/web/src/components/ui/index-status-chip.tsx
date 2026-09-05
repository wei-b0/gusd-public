/**
 * IndexStatusChip — provenance of the Index figure beside which it stands.
 * One vocabulary, everywhere: LIVE / STALE / WITHHELD / FROZEN / UNAVAILABLE.
 * Color is supported by the word itself — never color alone. Renders nothing
 * when the read is simulated: the mock data source's single admission lives
 * in the status line, not in a per-row confession.
 */

import type { IndexStatus } from "@/domain/types";

const CHIP: Record<IndexStatus, { label: string; tone: string }> = {
  live: { label: "LIVE", tone: "text-up" },
  stale: { label: "STALE", tone: "text-amber" },
  withheld: { label: "WITHHELD", tone: "text-down" },
  frozen: { label: "FROZEN", tone: "text-down" },
  unavailable: { label: "UNAVAILABLE", tone: "text-dim" },
};

export function IndexStatusChip({ status }: { status?: IndexStatus }) {
  if (!status) return null;
  const chip = CHIP[status];
  return (
    <span
      title="Index provenance"
      className={`slug shrink-0 border border-rule-strong px-1 py-0.5 text-[8.5px] ${chip.tone}`}
    >
      {chip.label}
    </span>
  );
}
