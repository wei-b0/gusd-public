import { describe, expect, it, vi } from "vitest";
import {
  ActionRunner,
  MAX_QUOTE_AGE_MS,
  MAX_QUOTE_AGE_BLOCKS,
  type ActionRunnerDeps,
} from "./action-runner";
import type { ActionOrigin, ActionPlan, ActionRecord } from "@/domain/actions";
import type { TxPort } from "@/domain/ports";
import type { TxRecord, TxSpec } from "@/domain/types";

/** A scripted tx port: each run consumes the next queued outcome. */
class FakeTxPort implements TxPort {
  ran: TxSpec[] = [];
  private queue: Array<(spec: TxSpec, index: number) => TxRecord | Promise<TxRecord>> = [];

  push(fn: (spec: TxSpec, index: number) => TxRecord | Promise<TxRecord>): void {
    this.queue.push(fn);
  }

  async run(spec: TxSpec): Promise<TxRecord> {
    this.ran.push(spec);
    // Mirror the real store: the spec's execute performs the sign/send, so
    // wrappers that observe it (the runner's phase mirror) fire.
    await spec
      .execute({ writeContract: async () => ({ hash: "0xfake" }) } as never)
      .catch(() => {});
    const step = this.queue.shift();
    if (!step) throw new Error("No scripted outcome for this tx run");
    return await step(spec, this.ran.length - 1);
  }

  list(): readonly TxRecord[] {
    return [];
  }

  get(): TxRecord | null {
    return null;
  }

  subscribe(): () => void {
    return () => {};
  }

  clear(): void {}
}

let txSeq = 0;
function txRecord(overrides: Partial<TxRecord> = {}): TxRecord {
  txSeq += 1;
  return {
    id: `tx-${txSeq}`,
    hash: `0xhash${txSeq}`,
    status: "confirmed",
    origin: "mint",
    kind: "approve",
    chainId: 31337,
    address: "0x00000000000000000000000000000000000000aa",
    createdAt: 1,
    updatedAt: 2,
    settledAt: 3,
    blockNumber: 5,
    error: null,
    ...overrides,
  };
}

function plan(overrides: Partial<ActionPlan> = {}): ActionPlan {
  return {
    origin: "mint" as ActionOrigin,
    label: "Mint 1,000.0000 gUSD",
    quote: { quotedAtMs: 1_000_000 - 1_000, blockNumber: 1, totals: { gUsd: 1000 } },
    approvals: [],
    buildSpec: () => ({ origin: "mint", kind: "mint", execute: async () => ({ hash: "0x1" }) }),
    ...overrides,
  };
}

function makeRunner(deps: Partial<ActionRunnerDeps> = {}) {
  const tx = new FakeTxPort();
  const runner = new ActionRunner({ tx, now: () => 1_000_000, newId: () => `action-${txSeq}`, ...deps });
  return { tx, runner };
}

/** Collect the phase timeline for the record with the given id. */
function phaseTimeline(runner: ActionRunner, id: string): string[] {
  const phases: string[] = [];
  runner.subscribe(() => {
    const record = runner.get(id);
    if (record && phases[phases.length - 1] !== record.phase) phases.push(record.phase);
  });
  return phases;
}

describe("ActionRunner", () => {
  it("drives approve-then-act to complete, with reconcile over both tx ids", async () => {
    const { tx, runner } = makeRunner();
    const reconcile = vi.fn(async () => {});
    tx.push(() => txRecord({ kind: "approve", status: "confirmed" }));
    tx.push(() => txRecord({ kind: "mint", status: "confirmed" }));

    const record = await runner.run(
      plan({
        approvals: [
          { token: "0xtoken", tokenLabel: "USDC", spender: "0xgusd", spenderKind: "gusd", amount: 1000n },
        ],
        simulate: async () => ({ ok: true }),
        reconcile,
      }),
    );

    expect(record.phase).toBe("complete");
    expect(record.error).toBeNull();
    expect(record.steps.map((s) => [s.kind, s.done, s.txId])).toEqual([
      ["approve", true, "tx-1"],
      ["action", true, "tx-2"],
    ]);
    expect(reconcile).toHaveBeenCalledWith(["tx-1", "tx-2"]);
    // The approval ran as its own approve-kind transaction.
    expect(tx.ran.map((s) => s.kind)).toEqual(["approve", "mint"]);
    expect(runner.isActionActive("mint")).toBe(false);
  });

  it("traverses the lifecycle phases in order", async () => {
    const { tx, runner } = makeRunner();
    tx.push(() => txRecord({ kind: "approve" }));
    tx.push(() => txRecord({ kind: "mint" }));
    let id: string | null = null;
    const phases: string[] = [];
    runner.subscribe(() => {
      const record = runner.list()[0];
      if (!record) return;
      id ??= record.id;
      if (phases[phases.length - 1] !== record.phase) phases.push(record.phase);
    });

    await runner.run(
      plan({
        approvals: [
          { token: "0xtoken", tokenLabel: "USDC", spender: "0xgusd", spenderKind: "gusd", amount: 1n },
        ],
        simulate: async () => ({ ok: true }),
      }),
    );

    expect(phases).toEqual([
      "validating",
      "approving",
      "simulating",
      "awaiting-signature",
      "submitted",
      "reconciling",
      "complete",
    ]);
    expect(id).toEqual(expect.stringMatching(/^action-/));
  });

  it("lands on declined and never builds the action when a signature is refused", async () => {
    const { tx, runner } = makeRunner();
    const buildSpec = vi.fn(() => plan().buildSpec());
    tx.push(() => txRecord({ kind: "approve", status: "rejected", error: "Signature declined. Connect again to continue." }));

    const record = await runner.run(
      plan({
        approvals: [
          { token: "0xtoken", tokenLabel: "USDC", spender: "0xgusd", spenderKind: "gusd", amount: 1n },
        ],
        buildSpec,
      }),
    );
    expect(record.phase).toBe("declined");
    expect(record.error).toMatch(/declined/i);
    expect(buildSpec).not.toHaveBeenCalled();
    expect(runner.isActionActive("mint")).toBe(false);
  });

  it("lands on reverted when the action itself reverts on-chain", async () => {
    const { tx, runner } = makeRunner();
    const reconcile = vi.fn(async () => {});
    tx.push(() => txRecord({ kind: "approve" }));
    tx.push(() =>
      txRecord({ kind: "mint", status: "reverted", error: "The transaction reverted on-chain. Nothing moved." }),
    );

    const record = await runner.run(
      plan({
        approvals: [
          { token: "0xtoken", tokenLabel: "USDC", spender: "0xgusd", spenderKind: "gusd", amount: 1n },
        ],
        reconcile,
      }),
    );
    expect(record.phase).toBe("reverted");
    expect(record.error).toMatch(/reverted/i);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("refuses a duplicate submission on the same surface and releases after settle", async () => {
    const { tx, runner } = makeRunner();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    tx.push(async () => {
      await gate;
      return txRecord({ kind: "mint" });
    });

    const first = runner.run(plan());
    await vi.waitFor(() => expect(runner.isActionActive("mint")).toBe(true));
    await expect(runner.run(plan())).rejects.toMatchObject({
      message: expect.stringMatching(/already in flight/i),
    });

    release();
    await first;
    // Guard released once the action settled.
    expect(runner.isActionActive("mint")).toBe(false);
    tx.push(() => txRecord({ kind: "mint" }));
    await expect(runner.run(plan())).resolves.toMatchObject({ phase: "complete" });
  });

  it("refuses a quote older than the age cap without any transaction", async () => {
    const { tx, runner } = makeRunner();
    const record = await runner.run(
      plan({ quote: { quotedAtMs: 1_000_000 - MAX_QUOTE_AGE_MS - 1, blockNumber: 1, totals: {} } }),
    );
    expect(record.phase).toBe("failed");
    expect(record.error).toMatch(/Quote expired/i);
    expect(tx.ran).toHaveLength(0);
  });

  it("refuses a quote the head has moved past, and accepts one at the boundary", async () => {
    const { tx, runner } = makeRunner({
      getBlockNumber: async () => 100 + MAX_QUOTE_AGE_BLOCKS + 1,
    });
    const refused = await runner.run(
      plan({ quote: { quotedAtMs: 1_000_000, blockNumber: 100, totals: {} } }),
    );
    expect(refused.phase).toBe("failed");
    expect(refused.error).toMatch(/Quote expired/i);
    expect(tx.ran).toHaveLength(0);

    const ok = new ActionRunner({
      tx,
      now: () => 1_000_000,
      newId: () => "action-boundary",
      getBlockNumber: async () => 100 + MAX_QUOTE_AGE_BLOCKS,
    });
    tx.push(() => txRecord({ kind: "mint" }));
    await expect(
      ok.run(plan({ quote: { quotedAtMs: 1_000_000, blockNumber: 100, totals: {} } })),
    ).resolves.toMatchObject({ phase: "complete" });
  });

  it("surfaces a simulation failure as validation without requesting a signature", async () => {
    const { tx, runner } = makeRunner();
    const record = await runner.run(
      plan({ simulate: async () => ({ ok: false, error: "The Index for this market is stale." }) }),
    );
    expect(record.phase).toBe("failed");
    expect(record.error).toMatch(/stale/i);
    expect(tx.ran).toHaveLength(0);
  });

  it("captures a pre-flight refusal (no session) as a failed action", async () => {
    const { runner } = makeRunner();
    const refusingTx = {
      run: () => Promise.reject(new Error("Connect a wallet first — nothing signs without one.")),
      list: () => [],
      get: () => null,
      subscribe: () => () => {},
      clear: () => {},
    } as unknown as TxPort;
    const gated = new ActionRunner({ tx: refusingTx, now: () => 1_000_000, newId: () => "action-gate" });

    const record: ActionRecord = await gated.run(plan());
    expect(record.phase).toBe("failed");
    expect(record.error).toMatch(/Connect a wallet first/i);
  });

  it("completes even when reconciliation throws — the tx confirmed", async () => {
    const { tx, runner } = makeRunner();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    tx.push(() => txRecord({ kind: "mint" }));
    const record = await runner.run(
      plan({ reconcile: async () => { throw new Error("indexer unreachable"); } }),
    );
    expect(record.phase).toBe("complete");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("lands the reconciler's indexed evidence on the record", async () => {
    const { tx, runner } = makeRunner();
    tx.push(() => txRecord({ kind: "mint" }));
    const record = await runner.run(
      plan({
        reconcile: async () => ({ balances: true, indexed: ["0xhash1"] }),
      }),
    );
    expect(record.phase).toBe("complete");
    expect(record.indexed).toEqual(["0xhash1"]);
  });

  it("keeps indexed null when the reconcile outcome carries no evidence", async () => {
    const { tx, runner } = makeRunner();
    tx.push(() => txRecord({ kind: "mint" }));
    const record = await runner.run(
      plan({
        reconcile: async () => ({ balances: true, indexed: null }),
      }),
    );
    expect(record.indexed).toBeNull();
  });
});
