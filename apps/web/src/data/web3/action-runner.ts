/**
 * The action runner — the orchestration layer above the tx lifecycle. One
 * ActionRunner owns every action this session ran and drives each plan from
 * quote to confirmation:
 *
 *   duplicate guard → stale-quote guard → approvals → simulation
 *     → signature → receipt → reconciliation
 *
 * The tx store beneath it still records each transaction separately
 * (signing → submitting → pending → settled); the runner mirrors the
 * progress into the action's phase and steps so a two-transaction flow
 * renders as one thing with named parts. Product failures resolve to their
 * record (UI reads state, not catches); only pre-flight refusals throw —
 * the duplicate guard throws, mirroring TxPort.run's no-session refusal.
 *
 * Records are session-local evidence, like tx records: never a portfolio or
 * history source.
 */

import type {
  ActionOrigin,
  ActionPhase,
  ActionPlan,
  ActionRecord,
  ActionStep,
  ReconcileOutcome,
} from "@/domain/actions";
import { isActionTerminal } from "@/domain/actions";
import type { TxPort } from "@/domain/ports";
import type { TxRecord, TxSpec } from "@/domain/types";
import { approveSpec } from "./approvals";

/** A quote older than this is refused — re-quote, don't execute blind. */
export const MAX_QUOTE_AGE_MS = 30_000;
/** …or once the head has moved this many blocks past the quote's block. */
export const MAX_QUOTE_AGE_BLOCKS = 2;

const STALE_QUOTE_VOICE = "Quote expired — review the new quote and try again.";

/** Extract the ReconcileOutcome-shaped fields from any reconcile result —
 *  the reconciler returns a richer record; the contract is duck-typed so
 *  ports may keep plain `Promise<unknown>` signatures. */
function indexedFromOutcome(outcome: unknown): readonly string[] | null {
  if (outcome === null || typeof outcome !== "object" || !("indexed" in outcome)) return null;
  const indexed = (outcome as ReconcileOutcome).indexed;
  return indexed ?? null;
}

/** The stale-quote guard reads the head block; injectable for tests. */
export type BlockNumberReader = () => Promise<number | null>;

export interface ActionRunnerDeps {
  tx: TxPort;
  now?: () => number;
  newId?: () => string;
  getBlockNumber?: BlockNumberReader;
}

export class ActionRunner {
  private records = new Map<string, ActionRecord>();
  private listeners = new Set<() => void>();
  private snapshot: readonly ActionRecord[] = [];
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly getBlockNumber?: BlockNumberReader;

  constructor(private readonly deps: ActionRunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.getBlockNumber = deps.getBlockNumber;
  }

  /** This session's actions, newest first (frozen references). */
  list(): readonly ActionRecord[] {
    return this.snapshot;
  }

  get(id: string): ActionRecord | null {
    return this.records.get(id) ?? null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** True while a non-terminal action sits on this surface — the desks'
   *  duplicate-submit gate. One in-flight action per surface. */
  isActionActive(origin: ActionOrigin): boolean {
    for (const record of this.snapshot) {
      if (record.origin === origin && !isActionTerminal(record.phase)) return true;
    }
    return false;
  }

  /** Clear session records (logout). */
  clear(): void {
    this.records.clear();
    this.snapshot = [];
    this.emit();
  }

  /**
   * Drive one plan end to end. Rejects only on the duplicate guard — every
   * product failure lands on the returned record's phase + error.
   */
  async run(plan: ActionPlan): Promise<ActionRecord> {
    if (this.isActionActive(plan.origin)) {
      throw new Error(
        "An action is already in flight here — wait for it to settle before starting another.",
      );
    }

    const id = this.newId();
    const t0 = this.now();
    const steps: ActionStep[] = plan.approvals.map((need) => ({
      kind: "approve" as const,
      label: `Approve ${need.tokenLabel}`,
      txId: null,
      hash: null,
      done: false,
    }));
    steps.push({ kind: "action", label: plan.label, txId: null, hash: null, done: false });

    const record: ActionRecord = {
      id,
      origin: plan.origin,
      label: plan.label,
      phase: "validating",
      steps,
      quote: plan.quote,
      error: null,
      txIds: [],
      indexed: null,
      createdAt: t0,
      updatedAt: t0,
    };
    this.put(record);

    // Stale-quote guard: an old quote is a refusal, not a warning — the
    // caps exist so the user never signs against a price that's gone.
    if (plan.quote) {
      if (this.now() - plan.quote.quotedAtMs > MAX_QUOTE_AGE_MS) {
        return this.settle(id, "failed", STALE_QUOTE_VOICE);
      }
      if (plan.quote.blockNumber != null && this.getBlockNumber) {
        const head = await this.getBlockNumber();
        if (head != null && head - plan.quote.blockNumber > MAX_QUOTE_AGE_BLOCKS) {
          return this.settle(id, "failed", STALE_QUOTE_VOICE);
        }
      }
    }

    const txIds: string[] = [];

    // Approvals first — one signature per spend permission, each its own
    // session transaction the user can decline.
    for (let i = 0; i < plan.approvals.length; i++) {
      this.patch(id, { phase: "approving" });
      const spec = approveSpec(plan.approvals[i]!, plan.origin);
      const outcome = await this.runTx(id, spec, i);
      if (typeof outcome !== "string") return this.settle(id, outcome.txPhase, outcome.voice);
      txIds.push(outcome);
    }

    // Pre-signature simulation: contract reverts surface as amber validation,
    // never as an onchain failure the user paid gas for.
    if (plan.simulate) {
      this.patch(id, { phase: "simulating" });
      const result = await plan.simulate();
      if (!result.ok) return this.settle(id, "failed", result.error);
    }

    // The action itself. buildSpec runs fresh at signature time.
    this.patch(id, { phase: "awaiting-signature" });
    const spec = plan.buildSpec();
    const actionIndex = steps.length - 1;
    const outcome = await this.runTx(id, this.mirrorPhases(spec, id), actionIndex);
    if (typeof outcome !== "string") return this.settle(id, outcome.txPhase, outcome.voice);
    txIds.push(outcome);

    // Confirmed on-chain — reconcile derived state, then complete. Whatever
    // the outcome reports about indexed evidence lands on the record: it is
    // what draws the confirmed-vs-indexed distinction in the ledgers.
    this.patch(id, { phase: "reconciling" });
    if (plan.reconcile) {
      try {
        const outcome = await plan.reconcile(txIds);
        this.patch(id, { indexed: indexedFromOutcome(outcome) });
      } catch (err) {
        // The transaction confirmed; a view that failed to refresh is a
        // console problem, not a user failure.
        console.error("[action-runner] reconcile failed:", err);
      }
    }
    return this.settle(id, "complete", null);
  }

  /**
   * Run one spec through the tx port. Returns the settled record id, or the
   * action-phase exit + product voice when the transaction did not confirm.
   */
  private async runTx(
    actionId: string,
    spec: TxSpec,
    stepIndex: number,
  ): Promise<string | { txPhase: ActionPhase; voice: string }> {
    let record: TxRecord;
    try {
      record = await this.deps.tx.run(spec);
    } catch (err) {
      // Pre-flight refusals (no session, wrong network) — already
      // product-voiced by the tx port.
      const voice = err instanceof Error ? err.message : "The wallet refused the request.";
      return { txPhase: "failed", voice };
    }
    this.patch(actionId, (current) => ({
      steps: current.steps.map((step, i) =>
        i === stepIndex ? { ...step, txId: record.id, hash: record.hash } : step,
      ),
      txIds: [...current.txIds, record.id],
    }));
    if (record.status !== "confirmed") {
      return {
        txPhase: record.status === "rejected" ? "declined" : record.status === "reverted" ? "reverted" : "failed",
        voice: record.error ?? "The transaction didn't go through. Try again in a moment.",
      };
    }
    this.patch(actionId, (current) => ({
      steps: current.steps.map((step, i) => (i === stepIndex ? { ...step, done: true } : step)),
    }));
    return record.id;
  }

  /** While the action tx is in flight, mirror the tx lifecycle into the
   *  action's phase so the desk tracks submitted → confirming live. */
  private mirrorPhases(spec: TxSpec, actionId: string): TxSpec {
    return {
      origin: spec.origin,
      kind: spec.kind,
      execute: async (wallet) => {
        const { hash } = await spec.execute(wallet);
        // The wallet returned a hash — it's on its way to the chain.
        this.noteSubmitted(actionId);
        return { hash };
      },
    };
  }

  private noteSubmitted(actionId: string): void {
    const current = this.records.get(actionId);
    if (current && !isActionTerminal(current.phase)) this.patch(actionId, { phase: "submitted" });
  }

  private settle(id: string, phase: ActionPhase, error: string | null): ActionRecord {
    this.patch(id, { phase, error });
    const settled = this.records.get(id);
    if (!settled) throw new Error(`Unknown action record ${id}`);
    return settled;
  }

  private patch(id: string, fields: Partial<ActionRecord>): void;
  private patch(id: string, update: (current: ActionRecord) => Partial<ActionRecord>): void;
  private patch(
    id: string,
    input: Partial<ActionRecord> | ((current: ActionRecord) => Partial<ActionRecord>),
  ): void {
    const current = this.records.get(id);
    if (!current) return;
    const fields = typeof input === "function" ? input(current) : input;
    this.put({ ...current, ...fields, updatedAt: this.now() });
  }

  /** Store, re-sort newest first, freeze the snapshot, notify. */
  private put(record: ActionRecord): void {
    this.records.set(record.id, record);
    const sorted = [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt);
    this.snapshot = sorted;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
