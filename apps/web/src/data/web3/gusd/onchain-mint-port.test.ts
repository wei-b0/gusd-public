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
  stableBalance: 2_000_000_000n as bigint,
  otherBalance: 2_000_000_000n as bigint,
  gusdBalance: 2_000_000_000n as bigint,
  /** The swap leg's quoted output; null = the pool cannot price the route. */
  swapOut: 999_000_000n as bigint | null,
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

vi.mock("../stables", () => ({
  stableMetaOf: (addr: string) => {
    if (addr.toLowerCase() === USDC.toLowerCase())
      return { address: USDC, symbol: "USDC", name: "USD Coin" };
    if (addr.toLowerCase() === USDT.toLowerCase())
      return { address: USDT, symbol: "USDT", name: "Tether USD" };
    return null;
  },
}));

vi.mock("../trading/quotes", () => ({
  quoterReadFor: () => ({
    quoteExactInputSingle: async ([p]: [{ exactAmount: bigint }]) => {
      if (h.swapOut === null) throw new Error("no pool");
      return [h.swapOut > p.exactAmount ? p.exactAmount : h.swapOut, 0n];
    },
    quoteExactOutputSingle: async () => {
      throw new Error("not used here");
    },
  }),
}));

vi.mock("../contracts", () => {
  const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
  return {
    getContracts: () => ({
      addresses: {
        gusd: "0x00000000000000000000000000000000000a0001",
        underlying: "0x00000000000000000000000000000000000a0003",
        stableRouter: "0x00000000000000000000000000000000000a0004",
      },
      gusd: {
        read: {
          previewMint: async ([raw]: [bigint]) => raw - ceilDiv(raw * BigInt(h.mintFeeBps), 10000n),
          previewRedeem: async ([raw]: [bigint]) =>
            raw - ceilDiv(raw * BigInt(h.redeemFeeBps), 10000n),
        },
      },
    }),
    erc20Client: () => ({
      read: { allowance: async () => h.allowance },
    }),
  };
});

const GUSD = "0x00000000000000000000000000000000000a0001";
const USDC = "0x00000000000000000000000000000000000a0003";
const STABLE_ROUTER = "0x00000000000000000000000000000000000a0004";
const USDT = "0x00000000000000000000000000000000000a0005";
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
      token === USDC ? h.stableBalance : token === USDT ? h.otherBalance : h.gusdBalance,
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
  h.stableBalance = 2_000_000_000n;
  h.otherBalance = 2_000_000_000n;
  h.gusdBalance = 2_000_000_000n;
  h.swapOut = 999_000_000n;
  h.sim = { ok: true };
});

describe("quote", () => {
  it("maps the contract preview into a desk quote — no session needed", async () => {
    const { port } = makePort(null);
    const q = await port.quote("mint", USDC, 1000);
    expect(q).toEqual({
      direction: "mint",
      asset: USDC,
      input: 1000,
      output: 998,
      fee: 2,
      feeBps: 20,
      paused: false,
      viaSwap: false,
      // the reserve path's preview is exact — no separate floor
      minOutput: null,
    });
  });

  it("quotes redemptions too", async () => {
    const { port } = makePort(null);
    const q = await port.quote("redeem", USDC, 1000);
    expect(q?.output).toBe(997.5);
    expect(q?.feeBps).toBe(25);
    expect(q?.viaSwap).toBe(false);
  });

  it("returns null for amounts that cannot be quoted", async () => {
    const { port } = makePort(CONNECTED);
    expect(await port.quote("mint", USDC, 0)).toBeNull();
    expect(await port.quote("mint", USDC, -5)).toBeNull();
    expect(await port.quote("mint", USDC, Number.NaN)).toBeNull();
  });

  it("composes the swap leg into a non-reserve mint quote", async () => {
    // 1000 USDT swaps to 999 underlying (mock), mints at 20bps.
    const { port } = makePort(null);
    const q = await port.quote("mint", USDT, 1000);
    expect(q?.viaSwap).toBe(true);
    expect(q?.output).toBe(997.002);
    expect(q?.fee).toBeCloseTo(1.998, 6);
    // the swap tolerance's signed floor surfaces with the quote — clipped
    // on the reserve leg (999 underlying × (1 − 0.5%)), below the output
    expect(q?.minOutput).toBeCloseTo(994.005, 2);
    expect(q!.minOutput!).toBeLessThan(q!.output);
  });

  it("returns null when no funding pool prices the route", async () => {
    h.swapOut = null;
    const { port } = makePort(CONNECTED);
    expect(await port.quote("mint", USDT, 1000)).toBeNull();
    expect(await port.quote("redeem", USDT, 1000)).toBeNull();
  });
});

describe("mint / redeem", () => {
  it("refuses to act without a session", async () => {
    const { port } = makePort(null);
    await expect(port.mint(USDC, 1000)).rejects.toThrow(
      "Connect a wallet to mint — nothing signs without one.",
    );
  });

  it("refuses non-positive amounts", async () => {
    const { port } = makePort(CONNECTED);
    await expect(port.mint(USDC, 0)).rejects.toThrow("Enter an amount greater than zero.");
  });

  it("refuses to mint while the contract is paused", async () => {
    h.paused = true;
    const { port } = makePort(CONNECTED);
    await expect(port.mint(USDC, 1000)).rejects.toThrow(
      "Minting is paused by the protocol operator — try again later.",
    );
    await expect(port.redeem(USDC, 1000)).rejects.toThrow(
      "Redemption is paused by the protocol operator — try again later.",
    );
  });

  it("refuses a mint larger than the stable balance — before any signature", async () => {
    h.stableBalance = 999_999_999n;
    const { port, actions } = makePort(CONNECTED);
    await expect(port.mint(USDC, 1000)).rejects.toThrow(
      "The wallet's USDC balance is too low for this mint — check the amount.",
    );
    expect(actions.plans).toHaveLength(0);
  });

  it("refuses a redemption larger than the gUSD balance", async () => {
    h.gusdBalance = 0n;
    const { port } = makePort(CONNECTED);
    await expect(port.redeem(USDC, 1000)).rejects.toThrow(
      "The wallet's gUSD balance is too low for this redemption — check the amount.",
    );
  });

  it("refuses a swap-path mint before the wallet is asked when no pool exists", async () => {
    h.swapOut = null;
    const { port, actions } = makePort(CONNECTED);
    await expect(port.mint(USDT, 1000)).rejects.toThrow(
      "No funding pool prices USDT → gUSD yet — LP depth has to exist before this mint routes.",
    );
    expect(actions.plans).toHaveLength(0);
  });

  it("plans a reserve-path mint with the GUSD approval, preview totals, and a simulation", async () => {
    const { port, actions } = makePort(CONNECTED);
    await port.mint(USDC, 1000);
    expect(actions.plans).toHaveLength(1);
    const plan = actions.plans[0]!;
    expect(plan.origin).toBe("mint");
    expect(plan.label).toBe("Mint 998.0000 gUSD");
    expect(plan.approvals).toHaveLength(1);
    expect(plan.approvals[0]).toMatchObject({
      token: USDC,
      spender: GUSD,
      spenderKind: "gusd",
      amount: 1_000_000_000n,
    });
    expect(plan.quote?.totals).toEqual({ input: 1000, output: 998, fee: 2 });
    expect(plan.simulate).toBeTypeOf("function");
    expect(plan.buildSpec().origin).toBe("mint");
  });

  it("plans a swap-path mint against the StableRouter with the clipped floor", async () => {
    const { port, actions } = makePort(CONNECTED);
    await port.mint(USDT, 1000);
    expect(actions.plans).toHaveLength(1);
    const plan = actions.plans[0]!;
    expect(plan.label).toBe("Mint 997.0020 gUSD via USDT");
    expect(plan.approvals).toHaveLength(1);
    expect(plan.approvals[0]).toMatchObject({
      token: USDT,
      spender: STABLE_ROUTER,
      spenderKind: "stableRouter",
      amount: 1_000_000_000n,
    });
    expect(plan.buildSpec().origin).toBe("mint");
  });

  it("skips the approval when the allowance already covers the mint", async () => {
    h.allowance = 1_000_000_000n;
    const { port, actions } = makePort(CONNECTED);
    await port.mint(USDC, 1000);
    expect(actions.plans[0]!.approvals).toHaveLength(0);
  });

  it("plans a redemption approval-free", async () => {
    const { port, actions } = makePort(CONNECTED);
    await port.redeem(USDC, 1000);
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
    await port.mint(USDC, 1000);
    const result = await actions.plans[0]!.simulate?.();
    expect(result).toEqual({ ok: false, error: "sim failed" });
  });
});
