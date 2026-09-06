import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { ActionPlan, ActionRecord } from "@/domain/actions";
import type { ActionPort } from "@/domain/ports";
import type { Account, TradeQuote } from "@/domain/types";
import { parseGpuUnits, parseGusd } from "@/domain/units";
import { fmtAddress } from "@/domain/format";
import { gpuIdForAsset } from "../gpu-id";
import type { OnChainAccountStore } from "@/data/onchain/account-store";
import { OnChainTradingPort } from "./onchain-trading-port";

/**
 * The port's orchestration, not the chain: quotes come from a stubbed quote
 * module, allowances from a stubbed ERC-20 read, and the assertions check
 * the plan the port hands the runner — label, approvals, the signed
 * structs, and the session gates.
 */

const GUSD = "0x00000000000000000000000000000000000a0001" as Address;
const ROUTER = "0x00000000000000000000000000000000000a0003" as Address;
const GPU_TOKEN = "0x00000000000000000000000000000000000a0002" as Address;
const OWNER = "0x00000000000000000000000000000000000000aa" as Address;
const GPU_ID = gpuIdForAsset("H100");

const h = vi.hoisted(() => ({
  session: {
    status: "connected",
    address: "0x00000000000000000000000000000000000000aa",
  } as { status: string; address: Address | null },
  quote: null as TradeQuote | null,
  /** (asset, side, size, toleranceBps, deps) captured per quote call. */
  quoteArgs: null as unknown[] | null,
  availability: null as unknown,
  allowance: 0n as bigint,
  /** Raw balances the fake ERC-20 read hands back per token flavor. */
  gusdBalance: 10_000_000n,
  gpuBalance: 10n ** 19n,
  registration: {
    token: "0x00000000000000000000000000000000000a0002",
  } as unknown,
  sim: { ok: true } as { ok: true } | { ok: false; error: { voice: string } },
  simReq: null as
    | null
    | { address: Address; functionName: string; args: readonly [Record<string, unknown>] },
}));

vi.mock("./quotes", () => ({
  DEFAULT_TOLERANCE_BPS: 50,
  TOLERANCE_PRESETS_BPS: [10, 50, 100],
  defaultQuoteDeps: () => ({}),
  describeAsset: async () => h.availability,
  quoteAsset: async (...args: unknown[]) => {
    h.quoteArgs = args;
    return h.quote;
  },
}));

vi.mock("../simulate", () => ({
  simulateWrite: async (req: never) => {
    h.simReq = req as typeof h.simReq;
    return h.sim;
  },
}));

vi.mock("../contracts", () => ({
  getContracts: () => ({
    addresses: { gusd: GUSD, router: ROUTER },
    router: { address: ROUTER },
  }),
  erc20Client: () => ({
    read: { allowance: async () => h.allowance },
  }),
}));

const BUY_QUOTE: TradeQuote = {
  asset: "H100",
  side: "buy",
  size: 2,
  price: 2.5,
  notional: 5,
  maxPaid: 5.2525,
  minOut: 0,
  legs: [
    { kind: "pool", gpuUnits: 1.5, gUsd: 4, fees: { protocol: 0.02 } },
    { kind: "issuance", gpuUnits: 0.5, gUsd: 1, fees: { issuance: 0.01 } },
  ],
  toleranceBps: 50,
  quotedAtMs: 1,
  blockNumber: 1,
};

const SELL_QUOTE: TradeQuote = {
  ...BUY_QUOTE,
  side: "sell",
  price: 1.9,
  notional: 3.8,
  maxPaid: 0,
  minOut: 1.9,
  legs: [{ kind: "pool", gpuUnits: 2, gUsd: 3.8, fees: { protocol: 0.02 } }],
};

class FakeActions implements ActionPort {
  plans: ActionPlan[] = [];
  async run(plan: ActionPlan): Promise<ActionRecord> {
    this.plans.push(plan);
    return {
      id: "action-1",
      origin: plan.origin,
      label: plan.label,
      phase: "complete",
      steps: [],
      quote: plan.quote,
      error: null,
      txIds: [],
      createdAt: 1,
      updatedAt: 1,
    };
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

/** The interim account store, reduced to what the port projects. */
class FakeStore {
  listeners = new Set<() => void>();
  snap = {
    address: null as string | null,
    gUsd: 0,
    sGusd: 0,
    positions: [] as readonly { gpuId: `0x${string}`; asset: string | null; token: Address; size: number }[],
  };
  get() {
    return this.snap;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  set(snap: typeof this.snap): void {
    this.snap = snap;
    for (const listener of this.listeners) listener();
  }
}

function makePort() {
  const actions = new FakeActions();
  const store = new FakeStore();
  const port = new OnChainTradingPort({
    getSession: () => h.session,
    actions,
    accountStore: store as unknown as OnChainAccountStore,
    quoteDeps: {
      reads: {
        registration: async () => h.registration,
        balanceOf: async (token: Address) =>
          token.toLowerCase() === GPU_TOKEN ? h.gpuBalance : h.gusdBalance,
      },
    },
  } as never);
  return { port, actions, store };
}

const BUY_REQUEST = { asset: "H100", side: "buy", size: 2, toleranceBps: 50 } as const;

beforeEach(() => {
  h.session = { status: "connected", address: OWNER };
  h.quote = BUY_QUOTE;
  h.quoteArgs = null;
  h.allowance = 0n;
  h.gusdBalance = 10_000_000n;
  h.gpuBalance = 10n ** 19n;
  h.registration = { token: GPU_TOKEN };
  h.sim = { ok: true };
  h.simReq = null;
});

describe("quote / describeAsset", () => {
  it("passes the request through with the resolved tolerance", async () => {
    const { port } = makePort();
    await port.quote({ asset: "H100", side: "buy", size: 2, toleranceBps: 10 });
    expect(h.quoteArgs?.slice(0, 4)).toEqual(["H100", "buy", 2, 10]);
  });

  it("defaults the tolerance to 50 bps", async () => {
    const { port } = makePort();
    await port.quote({ asset: "H100", side: "buy", size: 2 });
    expect(h.quoteArgs?.[3]).toBe(50);
  });

  it("describes assets through the quote layer", async () => {
    h.availability = {
      issuanceEnabled: true,
      poolRegistered: true,
      poolFeeBps: 30,
      hookFeeBps: 50,
      issuanceFeeBps: 50,
    };
    const { port } = makePort();
    expect(await port.describeAsset("H100")).toEqual(h.availability);
  });
});

describe("execute gates", () => {
  it("refuses to act without a session", async () => {
    h.session = { status: "idle", address: null };
    const { port, actions } = makePort();
    await expect(port.execute(BUY_REQUEST)).rejects.toThrow(
      "Connect a wallet to trade — nothing signs without one.",
    );
    expect(actions.plans).toHaveLength(0);
  });

  it("refuses to act when the quote fails", async () => {
    h.quote = null;
    const { port, actions } = makePort();
    await expect(port.execute(BUY_REQUEST)).rejects.toThrow(
      "This order can't be quoted right now — check the size and try again.",
    );
    expect(actions.plans).toHaveLength(0);
  });

  it("refuses a buy whose cap exceeds the wallet's gUSD, before any approval ask", async () => {
    h.gusdBalance = parseGusd(2);
    const { port, actions } = makePort();
    await expect(port.execute(BUY_REQUEST)).rejects.toThrow(
      "This wallet holds 2.0000 gUSD — this buy needs up to 5.2525 gUSD. Mint gUSD from the reserve asset first.",
    );
    expect(actions.plans).toHaveLength(0);
  });

  it("refuses a sell of more GPU than the wallet holds, before any approval ask", async () => {
    h.quote = SELL_QUOTE;
    h.gpuBalance = parseGpuUnits(1);
    const { port, actions } = makePort();
    await expect(port.execute({ asset: "H100", side: "sell", size: 2 })).rejects.toThrow(
      "This wallet holds 1.000 H100 — this sell needs 2.000 H100.",
    );
    expect(actions.plans).toHaveLength(0);
  });
});

describe("buy plans", () => {
  it("plans the buy with the gUSD approval, snapshot, and simulation", async () => {
    const { port, actions } = makePort();
    await port.execute(BUY_REQUEST);
    expect(actions.plans).toHaveLength(1);
    const plan = actions.plans[0]!;
    expect(plan.origin).toBe("trade");
    expect(plan.label).toBe("Buy 2.000 H100");
    expect(plan.approvals).toHaveLength(1);
    expect(plan.approvals[0]).toMatchObject({
      token: GUSD,
      spender: ROUTER,
      spenderKind: "router",
      amount: parseGusd(5.2525),
    });
    expect(plan.quote?.totals).toEqual({
      size: 2,
      maxPaid: 5.2525,
      notional: 5,
      poolLeg: 1.5,
      issuanceLeg: 0.5,
    });

    const sim = await plan.simulate?.();
    expect(sim).toEqual({ ok: true });
    expect(h.simReq?.functionName).toBe("buy");
    expect(h.simReq?.args[0]).toEqual({
      gpuId: GPU_ID,
      gpuOut: parseGpuUnits(2),
      poolGpuOut: parseGpuUnits(1.5),
      issueGpuOut: parseGpuUnits(0.5),
      payment: GUSD,
      maxPaid: parseGusd(5.2525),
      sqrtLimitX96: 0n,
    });

    const spec = plan.buildSpec();
    expect(spec.origin).toBe("trade");
    expect(spec.kind).toBe("trade-buy");
  });

  it("skips the approval when the gUSD allowance already covers the cap", async () => {
    h.allowance = parseGusd(5.2525);
    const { port, actions } = makePort();
    await port.execute(BUY_REQUEST);
    expect(actions.plans[0]!.approvals).toHaveLength(0);
  });

  it("passes a failed simulation through with the product voice", async () => {
    h.sim = { ok: false, error: { voice: "sim failed" } };
    const { port, actions } = makePort();
    await port.execute(BUY_REQUEST);
    expect(await actions.plans[0]!.simulate?.()).toEqual({ ok: false, error: "sim failed" });
  });
});

describe("sell plans", () => {
  it("plans the sell with the GPU approval and the sell struct", async () => {
    h.quote = SELL_QUOTE;
    const { port, actions } = makePort();
    await port.execute({ asset: "H100", side: "sell", size: 2 });
    const plan = actions.plans[0]!;
    expect(plan.label).toBe("Sell 2.000 H100");
    expect(plan.approvals).toHaveLength(1);
    expect(plan.approvals[0]).toMatchObject({
      token: GPU_TOKEN,
      spender: ROUTER,
      spenderKind: "router",
      amount: parseGpuUnits(2),
    });
    expect(plan.quote?.totals).toEqual({ size: 2, minOut: 1.9, notional: 3.8 });

    await plan.simulate?.();
    expect(h.simReq?.functionName).toBe("sell");
    expect(h.simReq?.args[0]).toEqual({
      gpuId: GPU_ID,
      gpuIn: parseGpuUnits(2),
      payout: GUSD,
      minOut: parseGusd(1.9),
      sqrtLimitX96: 0n,
    });

    const spec = plan.buildSpec();
    expect(spec.kind).toBe("trade-sell");
  });
});

describe("account projection", () => {
  it("projects the onchain snapshot — null basis, unregistered assets dropped", async () => {
    const { port, store } = makePort();
    expect(port.getAccount().connected).toBe(false);

    store.set({
      address: OWNER,
      gUsd: 10,
      sGusd: 5,
      positions: [
        { gpuId: GPU_ID, asset: "H100", token: GPU_TOKEN, size: 2 },
        { gpuId: "0x02", asset: null, token: GPU_TOKEN, size: 9 },
      ],
    });
    const account = port.getAccount();
    expect(account.connected).toBe(true);
    expect(account.label).toBe(fmtAddress(OWNER));
    expect(account.address).toBe(OWNER);
    expect(account.gUsdBalance).toBe(10);
    expect(account.sGUsdBalance).toBe(5);
    expect(account.positions).toEqual([{ asset: "H100", size: 2, avgEntry: null }]);
  });

  it("notifies subscribers when the store moves", async () => {
    const { port, store } = makePort();
    const seen: Account[] = [];
    port.subscribe((a) => seen.push(a));
    store.set({ address: OWNER, gUsd: 1, sGusd: 0, positions: [] });
    await vi.waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0]!.gUsdBalance).toBe(1);
  });

});
