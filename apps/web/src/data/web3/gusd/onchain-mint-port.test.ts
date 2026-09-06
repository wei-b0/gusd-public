import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionPlan, ActionRecord } from "@/domain/actions";
import type { ActionPort } from "@/domain/ports";
import type { Address } from "viem";
import type { ContractReads } from "../reads";
import { OnChainMintPort } from "./onchain-mint-port";

// Same contract math the desk quotes against — see actions.test.ts.
const h = vi.hoisted(() => ({
  mintFeeBps: 20,
  redeemFeeBps: 25,
  paused: false,
  allowance: 0n as bigint,
  usdcBalance: 2_000_000_000n as bigint,
  gusdBalance: 2_000_000_000n as bigint,
  sim: { ok: true } as { ok: true } | { ok: false; error: { voice: string } },
}));

vi.mock("../simulate", () => ({
  simulateWrite: async () => h.sim,
}));

vi.mock("../reads", () => ({
  contractReads: () => ({
    gusdState: async () => ({
      mintFeeBps: h.mintFeeBps,
      redeemFeeBps: h.redeemFeeBps,
      paused: h.paused,
    }),
  }),
}));

vi.mock("../contracts", () => {
  const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
  return {
    getContracts: () => ({
      addresses: {
        gusd: "0x00000000000000000000000000000000000a0001",
        usdc: "0x00000000000000000000000000000000000a0003",
      },
      gusd: {
        read: {
          previewMintUSDC: async ([raw]: [bigint]) =>
            raw - ceilDiv(raw * BigInt(h.mintFeeBps), 10000n),
          previewRedeemUSDC: async ([raw]: [bigint]) =>
            raw - ceilDiv(raw * BigInt(h.redeemFeeBps), 10000n),
        },
      },
    }),
    erc20Client: () => ({
      read: { allowance: async () => h.allowance },
    }),
  };
});

const OWNER = "0x00000000000000000000000000000000000000aa";

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
      token === "0x00000000000000000000000000000000000a0003" ? h.usdcBalance : h.gusdBalance,
  } as unknown as ContractReads;
}

function makePort(session: { status: string; address: string | null } | null) {
  const actions = new FakeActions();
  const port = new OnChainMintPort({
    getSession: () => session ?? { status: "idle", address: null },
    actions,
    reads: fakeReads(),
  });
  return { port, actions };
}

const CONNECTED = { status: "connected", address: OWNER };

beforeEach(() => {
  h.mintFeeBps = 20;
  h.redeemFeeBps = 25;
  h.paused = false;
  h.allowance = 0n;
  h.usdcBalance = 2_000_000_000n;
  h.gusdBalance = 2_000_000_000n;
  h.sim = { ok: true };
});

describe("quote", () => {
  it("maps the contract preview into a desk quote — no session needed", async () => {
    const { port } = makePort(null);
    const q = await port.quote("mint", 1000);
    expect(q).toEqual({
      direction: "mint",
      input: 1000,
      output: 998,
      fee: 2,
      feeBps: 20,
      paused: false,
    });
  });

  it("quotes redemptions too", async () => {
    const { port } = makePort(null);
    const q = await port.quote("redeem", 1000);
    expect(q?.output).toBe(997.5);
    expect(q?.feeBps).toBe(25);
  });

  it("returns null for amounts that cannot be quoted", async () => {
    const { port } = makePort(CONNECTED);
    expect(await port.quote("mint", 0)).toBeNull();
    expect(await port.quote("mint", -5)).toBeNull();
    expect(await port.quote("mint", Number.NaN)).toBeNull();
  });
});

describe("mint / redeem", () => {
  it("refuses to act without a session", async () => {
    const { port } = makePort(null);
    await expect(port.mint(1000)).rejects.toThrow(
      "Connect a wallet to mint — nothing signs without one.",
    );
  });

  it("refuses non-positive amounts", async () => {
    const { port } = makePort(CONNECTED);
    await expect(port.mint(0)).rejects.toThrow("Enter an amount greater than zero.");
  });

  it("refuses to mint while the contract is paused", async () => {
    h.paused = true;
    const { port } = makePort(CONNECTED);
    await expect(port.mint(1000)).rejects.toThrow(
      "Minting is paused by the protocol operator — try again later.",
    );
    await expect(port.redeem(1000)).rejects.toThrow(
      "Redemption is paused by the protocol operator — try again later.",
    );
  });

  it("refuses a mint larger than the USDC balance — before any signature", async () => {
    h.usdcBalance = 999_999_999n;
    const { port, actions } = makePort(CONNECTED);
    await expect(port.mint(1000)).rejects.toThrow(
      "The wallet's USDC balance is too low for this mint — check the amount.",
    );
    expect(actions.plans).toHaveLength(0);
  });

  it("refuses a redemption larger than the gUSD balance", async () => {
    h.gusdBalance = 0n;
    const { port } = makePort(CONNECTED);
    await expect(port.redeem(1000)).rejects.toThrow(
      "The wallet's gUSD balance is too low for this redemption — check the amount.",
    );
  });

  it("plans a mint with the USDC approval, preview totals, and a simulation", async () => {
    const { port, actions } = makePort(CONNECTED);
    await port.mint(1000);
    expect(actions.plans).toHaveLength(1);
    const plan = actions.plans[0]!;
    expect(plan.origin).toBe("mint");
    expect(plan.label).toBe("Mint 998.0000 gUSD");
    expect(plan.approvals).toHaveLength(1);
    expect(plan.approvals[0]).toMatchObject({
      token: "0x00000000000000000000000000000000000a0003",
      spender: "0x00000000000000000000000000000000000a0001",
      spenderKind: "gusd",
      amount: 1_000_000_000n,
    });
    expect(plan.quote?.totals).toEqual({ input: 1000, output: 998, fee: 2 });
    expect(plan.simulate).toBeTypeOf("function");
    expect(plan.buildSpec().origin).toBe("mint");
  });

  it("skips the approval when the allowance already covers the mint", async () => {
    h.allowance = 1_000_000_000n;
    const { port, actions } = makePort(CONNECTED);
    await port.mint(1000);
    expect(actions.plans[0]!.approvals).toHaveLength(0);
  });

  it("plans a redemption approval-free", async () => {
    const { port, actions } = makePort(CONNECTED);
    await port.redeem(1000);
    expect(actions.plans).toHaveLength(1);
    const plan = actions.plans[0]!;
    expect(plan.origin).toBe("redeem");
    expect(plan.label).toBe("Redeem 1,000.0000 gUSD");
    expect(plan.approvals).toHaveLength(0);
    expect(plan.buildSpec().origin).toBe("redeem");
  });

  it("rejects a plan's simulation failure as the product voice", async () => {
    h.sim = { ok: false, error: { voice: "sim failed" } };
    const { port, actions } = makePort(CONNECTED);
    await port.mint(1000);
    const result = await actions.plans[0]!.simulate?.();
    expect(result).toEqual({ ok: false, error: "sim failed" });
  });
});
