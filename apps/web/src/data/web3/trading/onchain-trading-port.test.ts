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
  /** The request object captured per quote call. */
  quoteRequest: null as unknown,
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
    | { address: Address; functionName: string; args: readonly unknown[] },
}));

vi.mock("./quotes", () => ({
  DEFAULT_TOLERANCE_BPS: 50,
  TOLERANCE_PRESETS_BPS: [10, 50, 100],
  defaultQuoteDeps: () => ({}),
  describeAsset: async () => h.availability,
  quoteAsset: async (request: unknown) => {
    h.quoteRequest = request;
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
  minSize: 0,
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
  minSize: 0,
  legs: [{ kind: "pool", gpuUnits: 2, gUsd: 3.8, fees: { protocol: 0.02 } }],
};

/** A money-first buy on the pool — the cap is the typed spend itself and
 *  the guarantee is the units floor. */
const SPEND_QUOTE: TradeQuote = {
  ...BUY_QUOTE,
  size: 7.96,
  price: 10 / 7.96,
  notional: 10,
  maxPaid: 10,
  minSize: 7.9202,
};

/** The same spend on a pool-less market — every leg is issuance, so the
 *  plan must ride the exact-out buy under the refundable spend cap. */
const GENESIS_SPEND_QUOTE: TradeQuote = {
  ...SPEND_QUOTE,
  size: 7.9601,
  price: 9.999876 / 7.9601,
  notional: 9.999876,
  minSize: 7.9601,
  legs: [
    { kind: "issuance", gpuUnits: 7.9601, gUsd: 9.999876, fees: { issuance: 0.049751 } },
  ],
};

/** A proceeds-first sell — the units are what the inverse quote derived. */
const PROCEEDS_SELL_QUOTE: TradeQuote = {
  ...SELL_QUOTE,
  size: 2.002,
  price: 3.8 / 2.002,
  minOut: 3.781,
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
      indexed: null,
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
    positions: [] as readonly {
      gpuId: `0x${string}`;
      asset: string | null;
      token: Address;
      size: number;
      avgEntry?: number | null;
      realizedPnl?: number | null;
      basisReason?: string | null;
    }[],
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

const BUY_REQUEST = { asset: "H100", side: "buy", basis: "units", size: 2, toleranceBps: 50 } as const;

beforeEach(() => {
  h.session = { status: "connected", address: OWNER };
  h.quote = BUY_QUOTE;
  h.quoteRequest = null;
  h.allowance = 0n;
  h.gusdBalance = 10_000_000n;
  h.gpuBalance = 10n ** 19n;
  h.registration = { token: GPU_TOKEN };
  h.sim = { ok: true };
  h.simReq = null;
});

describe("quote / describeAsset", () => {
  it("passes the request through to the quote layer untouched", async () => {
    const { port } = makePort();
    const request = { asset: "H100", side: "buy", basis: "gusd", gusd: 10, toleranceBps: 10 } as const;
    await port.quote(request);
    expect(h.quoteRequest).toBe(request); // verbatim — no defaulting here
  });

  it("forwards an omitted tolerance — the quote layer owns the default", async () => {
    const { port } = makePort();
    const request = { asset: "H100", side: "sell", basis: "units", size: 2 } as const;
    await port.quote(request);
    expect("toleranceBps" in (h.quoteRequest as Record<string, unknown>)).toBe(false);
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
    await expect(port.execute({ asset: "H100", side: "sell", basis: "units", size: 2 })).rejects.toThrow(
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
      minUnits: 0,
      poolLeg: 1.5,
      issuanceLeg: 0.5,
    });

    const sim = await plan.simulate?.();
    expect(sim).toEqual({ ok: true });
    expect(h.simReq?.functionName).toBe("buy");
    expect(h.simReq?.args[0]).toEqual({
      gpuId: GPU_ID,
      gpuOut: parseGpuUnits(2),
      payment: GUSD,
      maxPaid: parseGusd(5.2525),
      deadline: expect.any(BigInt),
      sqrtLimitX96: 0n,
      recipient: OWNER,
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
    await port.execute({ asset: "H100", side: "sell", basis: "units", size: 2 });
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
      deadline: expect.any(BigInt),
      sqrtLimitX96: 0n,
      recipient: OWNER,
    });

    const spec = plan.buildSpec();
    expect(spec.kind).toBe("trade-sell");
  });

  it("plans a proceeds-first sell against the quote's derived units", async () => {
    h.quote = PROCEEDS_SELL_QUOTE;
    const { port, actions } = makePort();
    await port.execute({ asset: "H100", side: "sell", basis: "gusd", gusd: 3.8, toleranceBps: 50 });
    const plan = actions.plans[0]!;
    expect(plan.label).toBe("Sell ~2.0020 H100 · ~3.8000 gUSD");
    // The approval is the derived gross units, not the typed proceeds.
    expect(plan.approvals[0]).toMatchObject({ token: GPU_TOKEN, amount: parseGpuUnits(2.002) });
    expect(plan.quote?.totals).toEqual({ size: 2.002, minOut: 3.781, notional: 3.8 });

    await plan.simulate?.();
    expect(h.simReq?.functionName).toBe("sell");
    expect(h.simReq?.args[0]).toEqual({
      gpuId: GPU_ID,
      gpuIn: parseGpuUnits(2.002),
      payout: GUSD,
      minOut: parseGusd(3.781),
      deadline: expect.any(BigInt),
      sqrtLimitX96: 0n,
      recipient: OWNER,
    });
    const spec = plan.buildSpec();
    expect(spec.kind).toBe("trade-sell");
  });

  it("refuses a proceeds-first sell of more units than the wallet holds", async () => {
    h.quote = PROCEEDS_SELL_QUOTE;
    h.gpuBalance = parseGpuUnits(2);
    const { port, actions } = makePort();
    await expect(
      port.execute({ asset: "H100", side: "sell", basis: "gusd", gusd: 3.8, toleranceBps: 50 }),
    ).rejects.toThrow("This wallet holds 2.000 H100 — this sell needs 2.002 H100.");
    expect(actions.plans).toHaveLength(0);
  });
});

describe("spend-first buy plans", () => {
  const SPEND_REQUEST = { asset: "H100", side: "buy", basis: "gusd", gusd: 10, toleranceBps: 50 } as const;

  it("plans the exact-pull buy through buyExactIn with the typed spend", async () => {
    h.quote = SPEND_QUOTE;
    const { port, actions } = makePort();
    await port.execute(SPEND_REQUEST);
    const plan = actions.plans[0]!;
    expect(plan.label).toBe("Buy ~7.9600 H100 · 10.0000 gUSD");
    // The approval is the typed spend — nothing padded, nothing refundable.
    expect(plan.approvals[0]).toMatchObject({
      token: GUSD,
      spender: ROUTER,
      amount: parseGusd(10),
    });
    expect(plan.quote?.totals).toEqual({
      size: 7.96,
      maxPaid: 10,
      notional: 10,
      minUnits: 7.9202,
      poolLeg: 1.5,
      issuanceLeg: 0.5,
    });

    await plan.simulate?.();
    expect(h.simReq?.functionName).toBe("buyExactIn");
    expect(h.simReq?.args).toEqual([
      GPU_ID,
      parseGusd(10),
      parseGpuUnits(7.9202),
      expect.any(BigInt),
      0n,
      OWNER,
    ]);

    const spec = plan.buildSpec();
    expect(spec.kind).toBe("trade-buy");
  });

  it("preflights the exact pull against the full spend, in its own voice", async () => {
    h.quote = SPEND_QUOTE;
    h.gusdBalance = parseGusd(9);
    const { port, actions } = makePort();
    await expect(port.execute(SPEND_REQUEST)).rejects.toThrow(
      "This wallet holds 9.0000 gUSD — this buy spends 10.0000 gUSD in full. Mint gUSD from the reserve asset first.",
    );
    expect(actions.plans).toHaveLength(0);
  });

  it("rides the exact-out buy under the typed-spend cap when every leg is issuance", async () => {
    h.quote = GENESIS_SPEND_QUOTE;
    const { port, actions } = makePort();
    await port.execute(SPEND_REQUEST);
    const plan = actions.plans[0]!;
    expect(plan.label).toBe("Buy ~7.9601 H100 · 10.0000 gUSD");
    expect(plan.approvals[0]).toMatchObject({ token: GUSD, amount: parseGusd(10) });

    await plan.simulate?.();
    expect(h.simReq?.functionName).toBe("buy");
    expect(h.simReq?.args[0]).toEqual({
      gpuId: GPU_ID,
      gpuOut: parseGpuUnits(7.9601),
      payment: GUSD,
      maxPaid: parseGusd(10),
      deadline: expect.any(BigInt),
      sqrtLimitX96: 0n,
      recipient: OWNER,
    });
    const spec = plan.buildSpec();
    expect(spec.kind).toBe("trade-buy");
  });

  it("speaks the refundable-cap voice on the genesis route", async () => {
    h.quote = GENESIS_SPEND_QUOTE;
    h.gusdBalance = parseGusd(9);
    const { port } = makePort();
    await expect(port.execute(SPEND_REQUEST)).rejects.toThrow(
      "This wallet holds 9.0000 gUSD — this buy needs up to 10.0000 gUSD. Mint gUSD from the reserve asset first.",
    );
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
    // A basis-less source (direct RPC) normalizes to null, never undefined.
    expect(account.positions).toEqual([
      { asset: "H100", size: 2, avgEntry: null, realizedPnl: null, basisReason: null },
    ]);
  });

  it("carries indexed cost basis through the projection", async () => {
    const { port, store } = makePort();
    store.set({
      address: OWNER,
      gUsd: 10,
      sGusd: 5,
      positions: [
        {
          gpuId: GPU_ID,
          asset: "H100",
          token: GPU_TOKEN,
          size: 2,
          avgEntry: 2.5,
          realizedPnl: 0.4,
          basisReason: null,
        },
        {
          gpuId: "0x03",
          asset: "A100",
          token: GPU_TOKEN,
          size: 1,
          avgEntry: null,
          realizedPnl: null,
          basisReason: "transfers_missing",
        },
      ],
    });
    expect(port.getAccount().positions).toEqual([
      { asset: "H100", size: 2, avgEntry: 2.5, realizedPnl: 0.4, basisReason: null },
      { asset: "A100", size: 1, avgEntry: null, realizedPnl: null, basisReason: "transfers_missing" },
    ]);
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
