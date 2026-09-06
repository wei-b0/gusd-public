/**
 * The action model — one user intent, however many transactions it takes.
 *
 * A single product action (buy, mint, deposit…) is often a sequence: an
 * approval, then the call itself, then reconciliation against balances. The
 * tx port records each transaction separately; the action model here is the
 * layer the desks render, so a two-transaction flow reads as one thing with
 * named steps rather than two disconnected ledger entries.
 *
 * Phases, in order:
 *
 *   validating → approval-required → approving → simulating
 *     → awaiting-signature → submitted → confirming
 *     → reconciling → complete
 *
 * with the failure exits `failed` (wallet/pre-flight/revert-with-error),
 * `declined` (the user refused a signature), and `reverted` (the call
 * executed on-chain and reverted). Terminal phases never leave.
 */

import type { Address } from "viem";
import type { TxSpec } from "./types";

/** Product surface an action belongs to — groups session ledgers. */
export type ActionOrigin = "trade" | "mint" | "redeem" | "earn" | "unearn";

export type ActionPhase =
  | "validating"
  | "approval-required"
  | "approving"
  | "simulating"
  | "awaiting-signature"
  | "submitted"
  | "confirming"
  | "reconciling"
  | "complete"
  | "failed"
  | "declined"
  | "reverted";

const TERMINAL_PHASES: readonly ActionPhase[] = [
  "complete",
  "failed",
  "declined",
  "reverted",
];

/** True once the action has settled — success or any failure exit. */
export function isActionTerminal(phase: ActionPhase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

/** Which protocol face an approval grants — display vocabulary only. */
export type SpenderKind = "router" | "gusd" | "sgusd" | "stableRouter";

/** One spend permission an action needs before it can execute. The runner
 *  turns each need into its own approval transaction (exact amount, never
 *  max — the router refunds by design, and an honest desk asks for what it
 *  needs). */
export interface ApprovalNeed {
  token: Address;
  tokenLabel: string;
  spender: Address;
  spenderKind: SpenderKind;
  /** Raw amount the allowance must reach (exactly what the action needs). */
  amount: bigint;
}

/** One transaction inside an action. `txId` links to the tx port's record
 *  once that transaction settles (the store's own id); `hash` is the chain
 *  transaction hash once the wallet returned one — what the ledgers print.
 *  Both are null while the step is queued or awaiting its wallet round-trip. */
export interface ActionStep {
  kind: "approve" | "action";
  label: string;
  txId: string | null;
  hash: string | null;
  done: boolean;
}

/**
 * The quote the action was built from — the runner refuses to execute
 * against a stale one. Totals are per-flow (the keys each flow defines:
 * `maxPaid`, `minOut`, `gUsd`…), in product units.
 */
export interface QuoteSnapshot {
  /** Wall-clock the quote was computed at. */
  quotedAtMs: number;
  /** Head block the quote was computed at, when the flow reads one. */
  blockNumber: number | null;
  /** Per-flow totals in product units, keyed by the flow's vocabulary. */
  totals: Readonly<Record<string, number>>;
}

/**
 * Everything the runner needs to take one action from quote to confirmation.
 * `buildSpec` is called fresh at signature time (it may close over
 * approval-fresh state); `simulate` runs pre-signature so contract reverts
 * surface as validation instead of an onchain failure the user paid gas
 * for; `reconcile` runs after confirmation to refresh derived state.
 */
export interface ActionPlan {
  origin: ActionOrigin;
  /** Human label for the whole action, e.g. "Buy 2.000 H100". */
  label: string;
  quote: QuoteSnapshot | null;
  approvals: readonly ApprovalNeed[];
  /**
   * Pre-signature simulation. `ok: false` carries the product-voiced reason;
   * no signature is ever requested for a reverting call.
   */
  simulate?: () => Promise<{ ok: true } | { ok: false; error: string }>;
  /** The action's own transaction. */
  buildSpec: () => TxSpec;
  /** Post-confirmation refresh (balances, positions). Failures here never
   *  fail the action — the transaction confirmed; the view just refreshes. */
  reconcile?: (txIds: readonly string[]) => Promise<unknown>;
}

/** One user action end to end — the record desks render. */
export interface ActionRecord {
  id: string;
  origin: ActionOrigin;
  label: string;
  phase: ActionPhase;
  steps: readonly ActionStep[];
  quote: QuoteSnapshot | null;
  /** Product-voiced failure reason on failed/declined/reverted; else null. */
  error: string | null;
  /** Every transaction hash-bearing record id this action drove. */
  txIds: readonly string[];
  createdAt: number;
  updatedAt: number;
}
