/**
 * The action receipt slot — one record's live (or settled) state: phase tag,
 * per-step labels with their hashes once settled, and the amber error box.
 * Confirmation wears reverse video; a revert is amber, not shame. Shared by
 * every action desk: the order slip, the mint desk, the earn desk.
 */

import type { ActionPhase, ActionRecord } from "@/domain/actions";
import { fmtHash } from "@/domain/format";

export function ActionStatus({ record }: { record: ActionRecord }) {
  return (
    <div aria-live="polite" className="mt-3 border border-rule-strong bg-panel-deep p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="slug text-dim">{record.label}</span>
        <PhaseTag phase={record.phase} />
      </div>
      {record.steps.length > 0 && (
        <div className="mt-1.5 space-y-1">
          {record.steps.map((step) => (
            <div key={`${step.kind}-${step.label}`} className="flex items-baseline justify-between gap-2">
              <span className={`slug ${step.done ? "text-data" : "text-dim"}`}>{step.label}</span>
              <span className="num text-[11px] text-dim">{step.hash ? fmtHash(step.hash) : "pending"}</span>
            </div>
          ))}
        </div>
      )}
      {record.error && (
        <p className="mt-1.5 border border-amber/40 bg-amber/10 p-2 text-[11px] leading-relaxed text-amber">
          {record.error}
        </p>
      )}
    </div>
  );
}

/** The in-flight phase voices, in the order the runner walks them. */
export const IN_FLIGHT_PHASE: Record<Exclude<ActionPhase, "complete" | "failed" | "declined" | "reverted">, string> = {
  validating: "Validating",
  "approval-required": "Approval required",
  approving: "Approving",
  simulating: "Simulating",
  "awaiting-signature": "Signing",
  submitted: "Submitted",
  confirming: "Confirming",
  reconciling: "Updating",
};

export function PhaseTag({ phase }: { phase: ActionPhase }) {
  if (phase === "complete") {
    return <span className="rev slug inline-block px-1.5 py-0.5 text-[9.5px]">Confirmed</span>;
  }
  if (phase === "failed" || phase === "declined" || phase === "reverted") {
    const label = phase === "failed" ? "Failed" : phase === "declined" ? "Declined" : "Reverted";
    return (
      <span className="slug inline-block border border-amber/40 px-1.5 py-0.5 text-[9.5px] text-amber">
        {label}
      </span>
    );
  }
  return <span className="slug text-[9.5px] text-amber">{IN_FLIGHT_PHASE[phase]}</span>;
}
