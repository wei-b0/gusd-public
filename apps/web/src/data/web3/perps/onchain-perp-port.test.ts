/**
 * The perp port against fakes — the earn-port suite's pattern. The engine's
 * read surface is stubbed at the contracts seam, the attestation at the
 * oracle seam, and every preview vector here is the same doctrine math the
 * Foundry suite pins (fees ceil, payouts floor, entries round against the
 * trader). Assertions target what the desk renders: the quote totals, the
 * refusal voices, and the plan each submit builds.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionPlan, ActionRecord } from "@/domain/actions";
import type { ActionPort } from "@/domain/ports";
import type { Address } from "viem";
import { OnChainPerpPort } from "./onchain-perp-port";
import { gpuIdForAsset } from "../gpu-id";

const H100 = gpuIdForAsset("H100");
const GUSD = "0x00000000000000000000000000000000000a0001";
const ENGINE = "0x00000000000000000000000000000000000a0003";
const OWNER = "0x00000000000000000000000000000000000000aa";
const MAX_UINT256 = 2n ** 256n - 1n;

const h = vi.hoisted(() => ({
  price: 30_000n as bigint, // 3.0000 USD/GPU-hour report price
  updateData: "0xdead" as `0x${string}`,
  attestationKind: "current" as string,
  gusdBalance: 1_000_000_000n as bigint,
  allowance: 0n as bigint,
  unknownMarket: false,
  market: {
    enabled: true,
    params: {
      maxLeverageBps: 20_000n,
      maintenanceMarginBps: 500n,
      openFeeBps: 10n,
      closeFeeBps: 10n,
      liquidationFeeBps: 100n,
      fundingRatePpmPerSec: 0n,
      borrowRatePpmPerSec: 0n,
      maxOiUsd: 1_000_000_000_000n,
      minCollateralUsd: 10_000_000n,
      maxPositionUsd: 100_000_000_000n,
    },
    openNotionalLong: 0n,
    openNotionalShort: 0n,
    fundingUpdatedAt: 0n,
    fundingChargePerUnitLong: 0n,
    fundingChargePerUnitShort: 0n,
    fundingCreditPerUnitLong: 0n,
    fundingCreditPerUnitShort: 0n,
    borrowChargePerUnit: 0n,
  },
  fundingRates: { long: 0n, short: 0n, borrow: 0n },
  position: null as {
    collateral: bigint;
    sizeUsd: bigint;
    entryPrice: bigint;
    fundingFeeCheckpoint: bigint;
    fundingCreditCheckpoint: bigint;
    borrowCheckpoint: bigint;
    earnedFunding: bigint;
  } | null,
  rawReadFails: false,
  view: {
    position: { sizeUsd: 0n, collateral: 0n, entryPrice: 0n, earnedFunding: 0n },
    uPnL: 0n,
    equity: 0n,
    maintenance: 0n,
    liquidatable: false,
    fundingDue: 0n,
  } as {
    position: { sizeUsd: bigint; collateral: bigint; entryPrice: bigint; earnedFunding: bigint };
    uPnL: bigint;
    equity: bigint;
    maintenance: bigint;
    liquidatable: boolean;
    fundingDue: bigint;
  },
  minExecutionFee: 10_000n,
  claimable: 0n as bigint,
  orderNonce: 5n,
  orders: new Map<number, Record<string, unknown>>(),
  sim: { ok: true } as { ok: true } | { ok: false; error: { voice: string } },
}));

vi.mock("../simulate", () => ({
  simulateWrite: async () => h.sim,
}));

vi.mock("../approvals", () => ({
  planApproval: async () => null,
}));

vi.mock("@/data/oracle/attestation", () => ({
  fetchAttestation: async () => ({ kind: h.attestationKind, updateData: h.updateData, price: h.price }),
  attestedPrice: (att: { price: bigint | null }) => att.price,
}));

vi.mock("../contracts", () => ({
  getContracts: () => ({
    addresses: { gusd: GUSD, sgusd: "0x00000000000000000000000000000000000a0002", perpEngine: ENGINE },
    gusd: {
      read: {
        balanceOf: async () => h.gusdBalance,
        allowance: async () => h.allowance,
      },
    },
    perpEngine: {
      read: {
        getMarket: async () => {
          if (h.unknownMarket) throw new Error("UnknownMarket()");
          return {
            market: h.market,
            fundingRateLongPpmPerSec: h.fundingRates.long,
            fundingRateShortPpmPerSec: h.fundingRates.short,
            borrowRatePpmPerSec: h.fundingRates.borrow,
          };
        },
        markets: async () => ({
          params: {
            maintenanceMarginBps: h.market.params.maintenanceMarginBps,
            closeFeeBps: h.market.params.closeFeeBps,
          },
          fundingChargePerUnitLong: h.market.fundingChargePerUnitLong,
          fundingChargePerUnitShort: h.market.fundingChargePerUnitShort,
          fundingCreditPerUnitLong: h.market.fundingCreditPerUnitLong,
          fundingCreditPerUnitShort: h.market.fundingCreditPerUnitShort,
          borrowChargePerUnit: h.market.borrowChargePerUnit,
        }),
        getPosition: async () => h.view,
        positions: async () => {
          if (h.rawReadFails) throw new Error("rpc down");
          return h.position;
        },
        MIN_EXECUTION_FEE: async () => h.minExecutionFee,
        orderNonce: async () => h.orderNonce,
        orders: async ([id]: [bigint]) => {
          const o = h.orders.get(Number(id));
          if (!o) throw new Error("no such order");
          return o;
        },
        claimableOf: async () => h.claimable,
      },
    },
  }),
  erc20Client: () => ({
    read: { allowance: async () => h.allowance },
  }),
}));

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
      quote: null,
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

function makePort(session: { status: string; address: string | null } | null) {
  const actions = new FakeActions();
  const port = new OnChainPerpPort({
    getSession: () => session ?? { status: "idle", address: null },
    actions,
    sleep: async () => {},
    getBlockNumber: async () => 7,
  });
  return { port, actions };
}

const CONNECTED = { status: "connected", address: OWNER };

beforeEach(() => {
  h.price = 30_000n;
  h.attestationKind = "current";
  h.gusdBalance = 1_000_000_000n;
  h.allowance = 0n;
  h.unknownMarket = false;
  h.market.enabled = true;
  h.market.openNotionalLong = 0n;
  h.market.openNotionalShort = 0n;
  h.market.fundingChargePerUnitLong = 0n;
  h.market.fundingChargePerUnitShort = 0n;
  h.market.fundingCreditPerUnitLong = 0n;
  h.market.fundingCreditPerUnitShort = 0n;
  h.market.borrowChargePerUnit = 0n;
  h.market.params.maxOiUsd = 1_000_000_000_000n;
  h.market.params.minCollateralUsd = 10_000_000n;
  h.market.params.maxPositionUsd = 100_000_000_000n;
  h.position = null;
  h.rawReadFails = false;
  h.view = {
    position: { sizeUsd: 0n, collateral: 0n, entryPrice: 0n, earnedFunding: 0n },
    uPnL: 0n,
    equity: 0n,
    maintenance: 0n,
    liquidatable: false,
    fundingDue: 0n,
  };
  h.claimable = 0n;
  h.orderNonce = 5n;
  h.orders = new Map();
  h.sim = { ok: true };
});

describe("describeMarket", () => {
  it("maps the engine's market state to the domain vocabulary", async () => {
    h.market.params.maxLeverageBps = 20_000n;
    h.market.openNotionalLong = 1_500_000_000n;
    h.fundingRates = { long: 1_234n, short: -1_234n, borrow: 40n };
    const { port } = makePort(null);
    const m = await port.describeMarket("H100");
    expect(m).not.toBeNull();
    expect(m!.asset).toBe("H100");
    expect(m!.maxLeverageBps).toBe(20_000);
    expect(m!.openInterestLong).toBe(1_500);
    expect(m!.minCollateralUsd).toBe(10);
    expect(m!.fundingRateLongPpmPerSec).toBeCloseTo(0.001234, 9);
    expect(m!.fundingRateShortPpmPerSec).toBeCloseTo(-0.001234, 9);
    expect(m!.borrowRatePpmPerSec).toBeCloseTo(0.00004, 9);
  });

  it("answers null for an unregistered market — an empty truth", async () => {
    h.unknownMarket = true;
    const { port } = makePort(null);
    expect(await port.describeMarket("H100")).toBeNull();
  });
});

describe("quoteOpen", () => {
  it("previews the exact order the create locks — guest, no session", async () => {
    const { port } = makePort(null);
    const q = await port.quoteOpen({ asset: "H100", side: "long", collateral: 10, leverage: 2, toleranceBps: 50 });
    expect(q).not.toBeNull();
    expect(q!.collateral).toBe(10);
    expect(q!.sizeUsd).toBe(20);
    expect(q!.openFee).toBe(0.02); // feeBps(20e6, 10) ceils to 20_000 raw
    expect(q!.executionFee).toBe(0.01);
    expect(q!.acceptablePrice).toBe(3.015); // long buys with an upper bound (ceil)
    // 10 coll − 1 maintenance (5% of 20 notional) = 9 headroom → x = 0.45 →
    // liq ≈ 3.0000 × (1 − 0.45) = 1.65 — the delta standalone (no funding).
    expect(q!.estLiquidationPrice).toBe(1.65);
    expect(q!.referencePrice).toBe(3);
    expect(q!.blockNumber).toBe(7);
  });

  it("shorts arm the lower bound, liquidation boundary above entry", async () => {
    const { port } = makePort(null);
    const q = await port.quoteOpen({ asset: "H100", side: "short", collateral: 10, leverage: 2, toleranceBps: 50 });
    expect(q!.acceptablePrice).toBe(2.985);
    expect(q!.estLiquidationPrice).toBeCloseTo(4.35, 9); // 3 × (1 + 9/20) = 4.35
  });

  it("refuses a collateral under the market's minimum", async () => {
    const { port } = makePort(CONNECTED);
    expect(await port.quoteOpen({ asset: "H100", side: "long", collateral: 5, leverage: 2 })).toBeNull();
  });

  it("refuses an order past the per-position cap", async () => {
    const { port } = makePort(CONNECTED);
    // 60,000 gUSD × 2× = 120,000 > the 100,000 cap.
    expect(
      await port.quoteOpen({ asset: "H100", side: "long", collateral: 60_000, leverage: 2 }),
    ).toBeNull();
  });

  it("refuses an order past the side's open-interest cap", async () => {
    h.market.params.maxOiUsd = 15_000_000n; // 15 gUSD
    const { port } = makePort(CONNECTED);
    expect(
      await port.quoteOpen({ asset: "H100", side: "long", collateral: 10, leverage: 2 }),
    ).toBeNull();
  });

  it("counts an existing position's collateral against the minimum", async () => {
    h.position = { collateral: 8_000_000n, sizeUsd: 16_000_000n, entryPrice: 30_000n, fundingFeeCheckpoint: 0n, fundingCreditCheckpoint: 0n, borrowCheckpoint: 0n, earnedFunding: 0n };
    const { port } = makePort(CONNECTED);
    // 8 locked + 6 new = 14 ≥ 10 minimum — but alone 6 < 10 would refuse.
    const q = await port.quoteOpen({ asset: "H100", side: "long", collateral: 6, leverage: 2 });
    expect(q).not.toBeNull();
    expect(q!.sizeUsd).toBe(12);
  });

  it("answers null with no current attestation", async () => {
    h.attestationKind = "stale";
    const { port } = makePort(null);
    expect(await port.quoteOpen({ asset: "H100", side: "long", collateral: 10, leverage: 2 })).toBeNull();
  });
});

describe("quoteClose", () => {
  beforeEach(() => {
    h.price = 33_000n; // the report moved up — the long is in profit
    // The raw struct behind the view — the slice math reads its checkpoints
    // (0 here, so the default vectors see zero accrued funding).
    h.position = {
      collateral: 20_000_000n,
      sizeUsd: 200_000_000n,
      entryPrice: 30_000n,
      fundingFeeCheckpoint: 0n,
      fundingCreditCheckpoint: 0n,
      borrowCheckpoint: 0n,
      earnedFunding: 0n,
    };
    h.view = {
      position: { sizeUsd: 200_000_000n, collateral: 20_000_000n, entryPrice: 30_000n, earnedFunding: 0n },
      uPnL: 20_000_000n,
      equity: 40_000_000n,
      maintenance: 1_000_000n,
      liquidatable: false,
      fundingDue: 0n,
    };
  });

  it("previews a whole close at the report price", async () => {
    const { port } = makePort(CONNECTED);
    const q = await port.quoteClose({ asset: "H100", side: "long", size: null, toleranceBps: 50 });
    expect(q).not.toBeNull();
    expect(q!.sizeUsd).toBe(200);
    expect(q!.entryPrice).toBe(3);
    expect(q!.pnl).toBe(20); // floor(200e6 × 3000 / 30000)
    expect(q!.closeFee).toBe(0.2); // feeBps(200e6, 10) = 200_000 raw
    expect(q!.executionFee).toBe(0.01);
    expect(q!.proceeds).toBe(39.8); // 20 coll + 20 pnl − 0.2 fee
    expect(q!.shortfall).toBe(0);
    // A long close refuses a fill below its bound — 3.3 × (1 − 0.5%) here.
    expect(q!.acceptablePrice).toBeCloseTo(3.2835, 9);
    // The position empties — nothing remains to liquidate.
    expect(q!.estLiquidationPrice).toBeNull();
  });

  it("previews a partial close pro-rata on collateral", async () => {
    const { port } = makePort(CONNECTED);
    const q = await port.quoteClose({ asset: "H100", side: "long", size: 100, toleranceBps: 50 });
    expect(q!.sizeUsd).toBe(100);
    expect(q!.pnl).toBe(10);
    expect(q!.proceeds).toBe(19.9); // 10 coll + 10 pnl − 0.1 fee
    // Remainder: 10 coll − 5 maintenance (5% of 100 held) = 5 headroom →
    // x = 0.05 → est ≈ 3.0000 × (1 − 0.05) = 2.85 at the unchanged entry.
    expect(q!.estLiquidationPrice).toBeCloseTo(2.85, 9);
  });

  it("floors a losing close at nothing — proceeds 0, the loss a shortfall voice", async () => {
    // Price 25.50: the long's loss (30) exceeds collateral + funding (20)
    // even before the close fee — onchain `due = max(raw, 0)` settles
    // nothing, so the quote must say 0 proceeds and a 10.2 shortfall.
    h.price = 25_500n;
    const { port } = makePort(CONNECTED);
    const q = await port.quoteClose({ asset: "H100", side: "long", size: null, toleranceBps: 50 });
    expect(q).not.toBeNull();
    expect(q!.pnl).toBe(-30); // ceil(200e6 × 4500 / 30000)
    expect(q!.proceeds).toBe(0); // 20 coll − 30 pnl − 0.2 fee < 0
    expect(q!.shortfall).toBeCloseTo(10.2, 9);
  });

  it("attributes the closed slice's funding pro-rata — the engine's G2 shape", async () => {
    // Cumulative deltas: 0.01 WAD owed, 0.001 WAD borrow, 0.005 WAD credit
    // per unit notional. The whole position accrued 2.0 owed + 0.2 borrow
    // and 1.0 earned; a half close settles only its slice (ceil charges,
    // floor credits) — never the whole position's funding.
    h.market.fundingChargePerUnitLong = 10_000_000_000_000_000n;
    h.market.borrowChargePerUnit = 1_000_000_000_000_000n;
    h.market.fundingCreditPerUnitLong = 5_000_000_000_000_000n;
    h.price = 30_000n;
    h.view = {
      position: { sizeUsd: 200_000_000n, collateral: 20_000_000n, entryPrice: 30_000n, earnedFunding: 0n },
      uPnL: 0n,
      equity: 20_000_000n,
      maintenance: 1_000_000n,
      liquidatable: false,
      // A whole-position figure — deliberately ignored by the slice math.
      fundingDue: -3_000_000n,
    };
    const { port } = makePort(CONNECTED);
    const q = await port.quoteClose({ asset: "H100", side: "long", size: 100, toleranceBps: 50 });
    expect(q!.fundingNet).toBeCloseTo(-0.6, 9); // 0.5 earned − 1.0 owed − 0.1 borrow
    expect(q!.proceeds).toBe(9.3); // 10 released − 0.1 fee − 1.0 owed − 0.1 borrow + 0.5 earned
    // Remainder: 10 coll − 0.5 maint − (1.0 owed + 0.1 borrow − 0.5 earned)
    // = 4.4 headroom → x = 0.044 → est ≈ 3.0000 × (1 − 0.044) = 2.868.
    expect(q!.estLiquidationPrice).toBeCloseTo(2.868, 9);
  });

  it("folds the carried earned balance into the slice — fold before slicing", async () => {
    // The engine's decrease folds the whole earned state (carried balance +
    // the un-accrued credit since the last touch) into the position BEFORE
    // slicing pro-rata. 1.0 carried + 1.0 un-accrued → 2.0 whole; a half
    // close slices 1.0 of it into the settlement, the remainder keeps 1.0
    // in its own balance.
    h.position = {
      collateral: 20_000_000n,
      sizeUsd: 200_000_000n,
      entryPrice: 30_000n,
      fundingFeeCheckpoint: 0n,
      fundingCreditCheckpoint: 0n,
      borrowCheckpoint: 0n,
      earnedFunding: 1_000_000n,
    };
    h.market.fundingCreditPerUnitLong = 5_000_000_000_000_000n; // +1.0 un-accrued
    h.price = 30_000n;
    h.view = {
      position: { sizeUsd: 200_000_000n, collateral: 20_000_000n, entryPrice: 30_000n, earnedFunding: 1_000_000n },
      uPnL: 0n,
      equity: 20_000_000n,
      maintenance: 1_000_000n,
      liquidatable: false,
      fundingDue: 2_000_000n, // whole-position: carried + un-accrued, no debt
    };
    const { port } = makePort(CONNECTED);
    const q = await port.quoteClose({ asset: "H100", side: "long", size: 100, toleranceBps: 50 });
    expect(q!.fundingNet).toBeCloseTo(1.0, 9); // +1.0 earned slice, no debt
    expect(q!.proceeds).toBe(10.9); // 10 released − 0.1 fee + 1.0 earned slice
    // Remainder keeps 1.0 earned in its balance: 10 coll − 5 maint (5% of
    // the 100 remaining) + 1.0 earned = 6.0 headroom → x = 0.06 →
    // 3.0 × (1 − 0.06) = 2.82 — the earned balance pushed the boundary out.
    expect(q!.estLiquidationPrice).toBeCloseTo(2.82, 9);
  });

  it("refuses without a session", async () => {
    const { port } = makePort(null);
    expect(await port.quoteClose({ asset: "H100", side: "long", size: null })).toBeNull();
  });

  it("refuses with no position", async () => {
    h.view.position.sizeUsd = 0n;
    const { port } = makePort(CONNECTED);
    expect(await port.quoteClose({ asset: "H100", side: "short", size: null })).toBeNull();
  });
});

describe("hasOpenPosition — the claim gate", () => {
  it("answers false without a session — nothing of the caller's can be open", async () => {
    const { port } = makePort(null);
    expect(await port.hasOpenPosition()).toBe(false);
  });

  it("answers false when every raw read saw zero size", async () => {
    h.position = {
      collateral: 0n,
      sizeUsd: 0n,
      entryPrice: 0n,
      fundingFeeCheckpoint: 0n,
      fundingCreditCheckpoint: 0n,
      borrowCheckpoint: 0n,
      earnedFunding: 0n,
    };
    const { port } = makePort(CONNECTED);
    expect(await port.hasOpenPosition()).toBe(false);
  });

  it("answers true when a side holds size", async () => {
    h.position = {
      collateral: 20_000_000n,
      sizeUsd: 200_000_000n,
      entryPrice: 30_000n,
      fundingFeeCheckpoint: 0n,
      fundingCreditCheckpoint: 0n,
      borrowCheckpoint: 0n,
      earnedFunding: 0n,
    };
    const { port } = makePort(CONNECTED);
    expect(await port.hasOpenPosition()).toBe(true);
  });

  it("answers null when a raw read fails — unreadable is never flat", async () => {
    h.rawReadFails = true;
    const { port } = makePort(CONNECTED);
    expect(await port.hasOpenPosition()).toBe(null);
  });
});

describe("getPosition probe", () => {
  const MARKED_VIEW = {
    position: { sizeUsd: 200_000_000n, collateral: 20_000_000n, entryPrice: 30_000n, earnedFunding: 0n },
    uPnL: 20_000_000n,
    equity: 40_000_000n,
    maintenance: 1_000_000n,
    liquidatable: false,
    fundingDue: -500_000n,
  };

  it("reads the verified view and derives the liquidation distance", async () => {
    h.position = { collateral: 20_000_000n, sizeUsd: 200_000_000n, entryPrice: 30_000n, fundingFeeCheckpoint: 0n, fundingCreditCheckpoint: 0n, borrowCheckpoint: 0n, earnedFunding: 0n };
    h.view = MARKED_VIEW;
    const { port } = makePort(CONNECTED);
    const p = await port.getPosition("H100", "long");
    expect(p.kind).toBe("ok");
    if (p.kind !== "ok") return;
    const s = p.position;
    expect(s.sizeUsd).toBe(200);
    expect(s.collateral).toBe(20);
    expect(s.markPrice).toBe(3); // the report the marked figures priced at
    expect(s.uPnl).toBe(20);
    expect(s.equity).toBe(40);
    expect(s.fundingNet).toBe(-0.5); // negative → the position earns
    expect(s.liquidatable).toBe(false);
    // 200 notional, 20 coll, 5% mm → maint 10 gUSD; headroom 10 gUSD = 5% of
    // notional → liq at 3.0 × 0.95 = 2.85 (the math suite's own vector).
    expect(s.liquidationPrice).toBeCloseTo(2.85, 9);
    expect(s.markedAt).toEqual(expect.any(Number));
  });

  it("answers flat only from a raw zero-size read", async () => {
    h.position = { collateral: 0n, sizeUsd: 0n, entryPrice: 0n, fundingFeeCheckpoint: 0n, fundingCreditCheckpoint: 0n, borrowCheckpoint: 0n, earnedFunding: 0n };
    const { port } = makePort(CONNECTED);
    expect(await port.getPosition("H100", "long")).toEqual({ kind: "flat" });
  });

  it("answers flat with no session — there is genuinely nothing there", async () => {
    const { port } = makePort(null);
    expect(await port.getPosition("H100", "long")).toEqual({ kind: "flat" });
  });

  it("falls back to raw figures when the attestation is stale — never null", async () => {
    h.position = { collateral: 20_000_000n, sizeUsd: 200_000_000n, entryPrice: 30_000n, fundingFeeCheckpoint: 0n, fundingCreditCheckpoint: 0n, borrowCheckpoint: 0n, earnedFunding: 0n };
    h.attestationKind = "stale";
    const { port } = makePort(CONNECTED);
    const p = await port.getPosition("H100", "long");
    expect(p.kind).toBe("unmarked");
    if (p.kind !== "unmarked") return;
    const s = p.position;
    // Existence is truth from the raw read; the marked half stays null —
    // the desk renders the raw figures, never a masked zero or a "Flat".
    expect(s.sizeUsd).toBe(200);
    expect(s.collateral).toBe(20);
    expect(s.entryPrice).toBe(3);
    expect(s.markPrice).toBeNull();
    expect(s.uPnl).toBeNull();
    expect(s.equity).toBeNull();
    expect(s.liquidationPrice).toBeNull();
    expect(s.markedAt).toBeNull();
  });

  it("answers unknown when the raw read fails — existence unreadable", async () => {
    h.rawReadFails = true;
    const { port } = makePort(CONNECTED);
    expect(await port.getPosition("H100", "long")).toEqual({ kind: "unknown" });
  });
});

describe("listPendingOrders", () => {
  it("answers null when every read fails after arming — never a fabricated empty", async () => {
    const { port } = makePort(CONNECTED);
    await port.open({ asset: "H100", side: "long", collateral: 10, leverage: 2 });
    // The session armed order id 6; every engine read now fails.
    h.orders.clear();
    expect(await port.listPendingOrders()).toBeNull();
  });

  it("answers [] without a session — an honest empty", async () => {
    const { port } = makePort(null);
    expect(await port.listPendingOrders()).toEqual([]);
  });
});

describe("open submission", () => {
  it("refuses without a session — before anything signs", async () => {
    const { port, actions } = makePort(null);
    await expect(port.open({ asset: "H100", side: "long", collateral: 10, leverage: 2 })).rejects.toThrow(
      "Connect a wallet to trade perps — nothing signs without one.",
    );
    expect(actions.plans).toHaveLength(0);
  });

  it("refuses a balance short of collateral + fee — before any signature", async () => {
    h.gusdBalance = 10_000_000n; // covers 10 gUSD collateral, not + fee
    const { port, actions } = makePort(CONNECTED);
    await expect(port.open({ asset: "H100", side: "long", collateral: 10, leverage: 2 })).rejects.toThrow(
      "This wallet doesn't hold the collateral and execution fee this open locks",
    );
    expect(actions.plans).toHaveLength(0);
  });

  it("plans the exact order with the pinned report's bound and no approval when covered", async () => {
    const { port, actions } = makePort(CONNECTED);
    const record = await port.open({ asset: "H100", side: "long", collateral: 10, leverage: 2, toleranceBps: 50 });
    expect(record.phase).toBe("complete");
    expect(actions.plans).toHaveLength(1);
    const plan = actions.plans[0]!;
    expect(plan.origin).toBe("perp-open");
    expect(plan.approvals).toHaveLength(0);
    expect(plan.simulate).toBeUndefined(); // pre-simulated in-port
    expect(plan.quote?.totals).toEqual({
      collateral: 10,
      size: 20,
      openFee: 0.02,
      executionFee: 0.01,
      acceptablePrice: 3.015,
    });
    const spec = plan.buildSpec();
    expect(spec.origin).toBe("perp-open");
    // The order nonce advanced — the session registry holds this order id
    // (the indexer is absent here, so the engine read is the fallback).
    h.orders.set(6, {
      account: OWNER,
      status: 1,
      kind: 0,
      isLong: true,
      sizeDeltaUsd: 20_000_000n,
      collateralDeltaUsd: 10_000_000n,
      acceptablePrice: 30_150n,
      triggerPrice: 0n,
      executionFee: 10_000n,
      createdAt: 0n,
      market: H100,
    });
    const pending = (await port.listPendingOrders())!;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.orderId).toBe(6);
    expect(pending[0]!.asset).toBe("H100");
    expect(pending[0]!.kind).toBe("open");
  });
});

describe("close / trigger submission", () => {
  beforeEach(() => {
    h.position = { collateral: 20_000_000n, sizeUsd: 200_000_000n, entryPrice: 30_000n, fundingFeeCheckpoint: 0n, fundingCreditCheckpoint: 0n, borrowCheckpoint: 0n, earnedFunding: 0n };
  });

  it("refuses when no position exists", async () => {
    h.position = null;
    const { port, actions } = makePort(CONNECTED);
    await expect(port.close({ asset: "H100", side: "long", size: null })).rejects.toThrow(
      "There's no position here to close.",
    );
    expect(actions.plans).toHaveLength(0);
  });

  it("plans a whole close locking only the execution fee", async () => {
    const { port, actions } = makePort(CONNECTED);
    await port.close({ asset: "H100", side: "long", size: null, toleranceBps: 50 });
    const plan = actions.plans[0]!;
    expect(plan.origin).toBe("perp-close");
    expect(plan.approvals).toHaveLength(0);
    expect(plan.label).toBe("Close long H100");
    expect(plan.quote?.totals).toEqual({ size: 200, executionFee: 0.01, acceptablePrice: 2.985 });
  });

  it("plans a partial close with the held clamped label", async () => {
    const { port, actions } = makePort(CONNECTED);
    await port.close({ asset: "H100", side: "long", size: 50, toleranceBps: 50 });
    const plan = actions.plans[0]!;
    expect(plan.quote?.totals).toMatchObject({ size: 50 });
    expect(plan.label).toBe("Close 50.0000 of long H100");
  });

  it("plans a stop-loss with a trigger price and no acceptable bound", async () => {
    const { port, actions } = makePort(CONNECTED);
    await port.armTrigger({ asset: "H100", side: "long", kind: "stop-loss", triggerPrice: 2.7, size: null });
    const plan = actions.plans[0]!;
    expect(plan.origin).toBe("perp-trigger");
    expect(plan.quote?.totals).toEqual({ size: 200, executionFee: 0.01, triggerPrice: 2.7 });
  });

  it("refuses a non-positive trigger price", async () => {
    const { port } = makePort(CONNECTED);
    await expect(port.armTrigger({ asset: "H100", side: "long", kind: "stop-loss", triggerPrice: 0, size: null })).rejects.toThrow(
      "Enter a trigger price greater than zero.",
    );
  });
});

describe("cancel / claim", () => {
  it("cancels own pending orders — approval-free", async () => {
    h.orders.set(3, { account: OWNER, status: 1, kind: 0, isLong: true });
    const { port, actions } = makePort(CONNECTED);
    await port.cancelOrder(3);
    expect(actions.plans[0]!.origin).toBe("perp-cancel");
    expect(actions.plans[0]!.approvals).toHaveLength(0);
  });

  it("refuses another account's order", async () => {
    h.orders.set(3, { account: "0x00000000000000000000000000000000000000bb", status: 1, kind: 0, isLong: true });
    const { port, actions } = makePort(CONNECTED);
    await expect(port.cancelOrder(3)).rejects.toThrow("That order isn't yours to cancel.");
    expect(actions.plans).toHaveLength(0);
  });

  it("refuses an already-resolved order", async () => {
    h.orders.set(3, { account: OWNER, status: 2, kind: 0, isLong: true });
    const { port } = makePort(CONNECTED);
    await expect(port.cancelOrder(3)).rejects.toThrow("That order already resolved");
  });

  it("claims the settled balance — approval-free, clamped to the counter", async () => {
    h.claimable = 5_000_000n;
    const { port, actions } = makePort(CONNECTED);
    await port.claim(99); // clamps to 5
    const plan = actions.plans[0]!;
    expect(plan.origin).toBe("perp-claim");
    expect(plan.approvals).toHaveLength(0);
    expect(plan.quote?.totals).toEqual({ claim: 5 });
  });

  it("refuses a claim against an empty counter", async () => {
    const { port } = makePort(CONNECTED);
    await expect(port.claim(5)).rejects.toThrow("There's nothing settled to claim right now.");
  });

  it("refuses to act without a session at every seam", async () => {
    const { port } = makePort(null);
    await expect(port.cancelOrder(1)).rejects.toThrow("Connect a wallet to trade perps");
    await expect(port.claim(1)).rejects.toThrow("Connect a wallet to trade perps");
    await expect(port.close({ asset: "H100", side: "long", size: null })).rejects.toThrow(
      "Connect a wallet to trade perps",
    );
    expect(await port.getClaimable()).toBeNull();
    expect(await port.listPendingOrders()).toEqual([]);
  });
});