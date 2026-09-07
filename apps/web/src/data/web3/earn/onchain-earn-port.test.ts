import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionPlan, ActionRecord } from "@/domain/actions";
import type { ActionPort } from "@/domain/ports";
import type { Address } from "viem";
import type { ContractReads } from "../reads";
import { OnChainEarnPort } from "./onchain-earn-port";

// Same vault math the desk quotes against — see actions.test.ts. 1:1 at
// the seed price keeps the plan arithmetic legible; the rate tests cover
// the snapshot store separately.
const h = vi.hoisted(() => ({
  rate: 1,
  seeded: true,
  maxDeposit: 2n ** 256n - 1n,
  maxWithdraw: 2n ** 256n - 1n,
  gusdBalance: 2_000_000_000n as bigint,
  sgusdBalance: 2_000_000_000n as bigint,
  allowance: 0n as bigint,
  sim: { ok: true } as { ok: true } | { ok: false; error: { voice: string } },
}));

vi.mock("../simulate", () => ({
  simulateWrite: async () => h.sim,
}));

vi.mock("../contracts", () => ({
  getContracts: () => ({
    addresses: {
      gusd: "0x00000000000000000000000000000000000a0001",
      sgusd: "0x00000000000000000000000000000000000a0002",
    },
    sgusd: {
      read: {
        previewDeposit: async ([assets]: [bigint]) => assets,
        previewWithdraw: async ([assets]: [bigint]) => assets,
      },
    },
  }),
  erc20Client: () => ({
    read: { allowance: async () => h.allowance },
  }),
}));

const GUSD = "0x00000000000000000000000000000000000a0001";
const SGUSD = "0x00000000000000000000000000000000000a0002";
const OWNER = "0x00000000000000000000000000000000000000aa";
const MAX_UINT256 = 2n ** 256n - 1n;

class FakeActions implements ActionPort {
  plans: ActionPlan[] = [];
  next: ActionRecord | null = null;
  async run(plan: ActionPlan): Promise<ActionRecord> {
    this.plans.push(plan);
    return (
      this.next ?? {
        id: "action-1",
        origin: plan.origin,
        label: plan.label,
        phase: "complete",
        steps: [],
        quote: null,
        error: null,
        txIds: [],
        indexed: null,
        createdAt: 1,
        updatedAt: 1,
      }
    );
  }
  list() {
    return [];
  }
  get(): ActionRecord | null {
    return null;
  }
  subscribe() {
    return () => {};
  }
  isActionActive(): boolean {
    return false;
  }
  clear() {}
}

function fakeReads(): ContractReads {
  return {
    balanceOf: async (token: Address) =>
      token === SGUSD ? h.sgusdBalance : h.gusdBalance,
    sgusdState: async (_owner: Address) => ({
      rate: h.rate,
      seeded: h.seeded,
      maxDeposit: h.maxDeposit,
      maxWithdraw: h.maxWithdraw,
    }),
  } as unknown as ContractReads;
}

function makePort(session: { status: string; address: string | null } | null) {
  const actions = new FakeActions();
  const port = new OnChainEarnPort({
    getSession: () => session ?? { status: "idle", address: null },
    actions,
    reads: fakeReads(),
  });
  return { port, actions };
}

const CONNECTED = { status: "connected", address: OWNER };

beforeEach(() => {
  h.rate = 1;
  h.seeded = true;
  h.maxDeposit = MAX_UINT256;
  h.maxWithdraw = MAX_UINT256;
  h.gusdBalance = 2_000_000_000n;
  h.sgusdBalance = 2_000_000_000n;
  h.allowance = 0n;
  h.sim = { ok: true };
});

describe("quote", () => {
  it("previews stakes and unstakes from the vault — no session needed", async () => {
    const { port } = makePort(null);
    expect(await port.quote("stake", 1000)).toEqual({
      direction: "stake",
      input: 1000,
      shares: 1000,
    });
    expect(await port.quote("unstake", 1000)).toEqual({
      direction: "unstake",
      input: 1000,
      shares: 1000,
    });
  });

  it("returns null for amounts that cannot be quoted", async () => {
    const { port } = makePort(CONNECTED);
    expect(await port.quote("stake", 0)).toBeNull();
    expect(await port.quote("stake", -5)).toBeNull();
    expect(await port.quote("stake", Number.NaN)).toBeNull();
  });
});

describe("deposit / withdraw refusals", () => {
  it("refuses to act without a session", async () => {
    const { port } = makePort(null);
    await expect(port.deposit(1000)).rejects.toThrow(
      "Connect a wallet to earn — nothing signs without one.",
    );
  });

  it("refuses non-positive amounts", async () => {
    const { port } = makePort(CONNECTED);
    await expect(port.deposit(0)).rejects.toThrow("Enter an amount greater than zero.");
  });

  it("refuses deposits while the vault is unseeded", async () => {
    h.seeded = false;
    const { port } = makePort(CONNECTED);
    await expect(port.deposit(1000)).rejects.toThrow(
      "The vault hasn't been seeded yet — deposits open once it holds its seed.",
    );
  });

  it("refuses a stake past the vault's deposit cap", async () => {
    h.maxDeposit = 500_000_000n;
    const { port, actions } = makePort(CONNECTED);
    await expect(port.deposit(1000)).rejects.toThrow(
      "That deposit exceeds the vault's current deposit cap — check the amount.",
    );
    expect(actions.plans).toHaveLength(0);
  });

  it("refuses an unstake past this position's withdraw cap", async () => {
    h.maxWithdraw = 500_000_000n;
    const { port } = makePort(CONNECTED);
    await expect(port.withdraw(1000)).rejects.toThrow(
      "That unstake is more than this position can pay out right now — check the amount.",
    );
  });

  it("refuses a stake larger than the gUSD balance — before any signature", async () => {
    h.gusdBalance = 999_999_999n;
    const { port, actions } = makePort(CONNECTED);
    await expect(port.deposit(1000)).rejects.toThrow(
      "The wallet's gUSD balance is too low for this stake — check the amount.",
    );
    expect(actions.plans).toHaveLength(0);
  });

  it("refuses an unstake larger than the sGUSD balance", async () => {
    h.sgusdBalance = 0n;
    const { port } = makePort(CONNECTED);
    await expect(port.withdraw(1000)).rejects.toThrow(
      "The wallet's sGUSD balance is too low for this unstake — check the amount.",
    );
  });
});

describe("deposit / withdraw plans", () => {
  it("plans a stake with the gUSD approval, preview totals, and a simulation", async () => {
    const { port, actions } = makePort(CONNECTED);
    await port.deposit(1000);
    expect(actions.plans).toHaveLength(1);
    const plan = actions.plans[0]!;
    expect(plan.origin).toBe("earn");
    expect(plan.label).toBe("Stake 1,000.0000 gUSD");
    expect(plan.approvals).toHaveLength(1);
    expect(plan.approvals[0]).toMatchObject({
      token: GUSD,
      spender: SGUSD,
      spenderKind: "sgusd",
      amount: 1_000_000_000n,
    });
    expect(plan.quote?.totals).toEqual({ input: 1000, shares: 1000 });
    expect(plan.simulate).toBeTypeOf("function");
    expect(plan.buildSpec().origin).toBe("earn");
  });

  it("skips the approval when the allowance already covers the stake", async () => {
    h.allowance = 1_000_000_000n;
    const { port, actions } = makePort(CONNECTED);
    await port.deposit(1000);
    expect(actions.plans[0]!.approvals).toHaveLength(0);
  });

  it("plans an unstake approval-free", async () => {
    const { port, actions } = makePort(CONNECTED);
    await port.withdraw(1000);
    expect(actions.plans).toHaveLength(1);
    const plan = actions.plans[0]!;
    expect(plan.origin).toBe("unearn");
    expect(plan.label).toBe("Unstake 1,000.0000 gUSD");
    expect(plan.approvals).toHaveLength(0);
    expect(plan.buildSpec().origin).toBe("unearn");
  });

  it("rejects a plan's simulation failure as the product voice", async () => {
    h.sim = { ok: false, error: { voice: "sim failed" } };
    const { port, actions } = makePort(CONNECTED);
    await port.deposit(1000);
    const result = await actions.plans[0]!.simulate?.();
    expect(result).toEqual({ ok: false, error: "sim failed" });
  });
});

describe("vault snapshot store", () => {
  it("starts null and populates from the vault's public facts", async () => {
    h.rate = 1.05;
    const { port } = makePort(CONNECTED);
    expect(port.getEarnState()).toEqual({ rate: null, seeded: null, updatedAt: null });
    await port.refresh();
    const state = port.getEarnState();
    expect(state.rate).toBe(1.05);
    expect(state.seeded).toBe(true);
    expect(state.updatedAt).not.toBeNull();
  });

  it("notifies subscribers when the snapshot moves", async () => {
    h.rate = 1.05;
    const { port } = makePort(CONNECTED);
    const listener = vi.fn();
    port.subscribe(listener);
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    expect(port.getEarnState().rate).toBe(1.05);
  });

  it("keeps the last snapshot when a vault read fails", async () => {
    const actions = new FakeActions();
    const port = new OnChainEarnPort({
      getSession: () => CONNECTED,
      actions,
      reads: {
        sgusdState: async () => {
          throw new Error("node down");
        },
      } as unknown as ContractReads,
    });
    await port.refresh(); // must not throw
    expect(port.getEarnState()).toEqual({ rate: null, seeded: null, updatedAt: null });
  });
});
