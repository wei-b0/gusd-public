/**
 * Decision tests for the tick evaluator against a synthetic book. The gpuId
 * conversion is the real codec (encodeGpuId) on both the market keys and the
 * candidate SKU, so a codec drift fails loudly here.
 */
import { describe, expect, it } from "vitest";
import { encodeGpuId } from "@gusd/attestor-client";
import { evaluateTick, type CandidateTick } from "../strategy.js";
import { Book, type KeeperMarket, type KeeperOrder, type KeeperPosition } from "../state.js";

const NOW = 1_000_000n;

function tick(over: Partial<CandidateTick> = {}): CandidateTick {
  return { gpuId: "H100_SXM_80GB", price: 3.25, status: "healthy", calcHash: "0xabc", ...over };
}

function mkBook(): Book {
  return new Book({} as never, "test_schema", 31337);
}

const H100 = encodeGpuId("H100_SXM_80GB").toLowerCase();

function mkMarket(over: Partial<KeeperMarket> = {}): KeeperMarket {
  return {
    gpuId: H100,
    enabled: true,
    maxLeverageBps: 200_000n,
    maintenanceMarginBps: 500n,
    openFeeBps: 10n,
    closeFeeBps: 10n,
    liquidationFeeBps: 100n,
    fundingRatePpmPerSec: 0n,
    borrowRatePpmPerSec: 0n,
    maxOiUsd: 1_000_000_000n,
    minCollateralUsd: 10n,
    maxPositionUsd: 100_000_000n,
    openNotionalLong: 0n,
    openNotionalShort: 0n,
    fundingChargePerUnitLong: 0n,
    fundingChargePerUnitShort: 0n,
    fundingCreditPerUnitLong: 0n,
    fundingCreditPerUnitShort: 0n,
    borrowChargePerUnit: 0n,
    fundingUpdatedAtSec: NOW,
    ...over,
  };
}

function mkOrder(over: Partial<KeeperOrder> = {}): KeeperOrder {
  return {
    orderId: 1n,
    account: "0xaaa0000000000000000000000000000000000001",
    kind: 0,
    isLong: true,
    sizeDeltaUsd: 1_000_000n,
    collateralDeltaUsd: 500_000n,
    acceptablePrice: 33_000n,
    triggerPrice: 0n,
    executionFee: 10_000n,
    createdAtSec: NOW - 60n,
    market: H100,
    ...over,
  };
}

function mkPosition(over: Partial<KeeperPosition> = {}): KeeperPosition {
  return {
    wallet: "0xbbb0000000000000000000000000000000000002",
    gpuId: H100,
    isLong: true,
    sizeUsd: 1_000_000n,
    collateral: 500_000n,
    entryPrice: 32_500n,
    fundingFeeCheckpoint: 0n,
    fundingCreditCheckpoint: 0n,
    borrowCheckpoint: 0n,
    lastTouchedAtSec: NOW - 60n,
    ...over,
  };
}

function add(book: Book, market: KeeperMarket, orders: KeeperOrder[] = [], positions: KeeperPosition[] = []): void {
  book.markets.set(market.gpuId, market);
  for (const o of orders) book.orders.set(String(o.orderId), o);
  for (const p of positions) book.positions.set(`${p.wallet}|${p.gpuId}|${p.isLong}`, p);
}

describe("evaluateTick", () => {
  it("executes a market increase once the delay has passed and the bound holds", () => {
    const book = mkBook();
    add(book, mkMarket(), [mkOrder()]);
    const items = evaluateTick(book, 15n, tick({ price: 3.0 }), NOW);
    expect(items).toEqual([
      {
        type: "executeOrder",
        orderId: 1n,
        wallet: "0xaaa0000000000000000000000000000000000001",
        sku: "H100_SXM_80GB",
        gpuId: H100,
        reason: expect.any(String),
      },
    ]);
  });

  it("skips an increase whose acceptable price fails (order stays armed)", () => {
    const book = mkBook();
    add(book, mkMarket(), [mkOrder({ acceptablePrice: 30_000n })]); // long buys ≤ 3.0000
    expect(evaluateTick(book, 15n, tick({ price: 3.25 }), NOW)).toEqual([]);
  });

  it("skips an order still inside minOrderDelay", () => {
    const book = mkBook();
    add(book, mkMarket(), [mkOrder({ createdAtSec: NOW - 5n })]);
    expect(evaluateTick(book, 15n, tick(), NOW)).toEqual([]);
  });

  it("skips an increase on a disabled market", () => {
    const book = mkBook();
    add(book, mkMarket({ enabled: false }), [mkOrder()]);
    expect(evaluateTick(book, 15n, tick(), NOW)).toEqual([]);
  });

  it("fires a TP on the boundary and an SL below it", () => {
    const bookTp = mkBook();
    add(bookTp, mkMarket(), [
      mkOrder({ orderId: 1n, kind: 3, triggerPrice: 32_500n, sizeDeltaUsd: 0n, acceptablePrice: 0n }),
    ]);
    expect(evaluateTick(bookTp, 15n, tick({ price: 3.25 }), NOW)).toHaveLength(1);
    expect(evaluateTick(bookTp, 15n, tick({ price: 3.24 }), NOW)).toEqual([]);

    const bookSl = mkBook();
    add(bookSl, mkMarket(), [
      mkOrder({ orderId: 2n, kind: 2, triggerPrice: 32_500n, sizeDeltaUsd: 0n, acceptablePrice: 0n }),
    ]);
    expect(evaluateTick(bookSl, 15n, tick({ price: 3.25 }), NOW)).toHaveLength(1); // inclusive ≤
  });

  it("marks an underwater position for liquidation, before orders", () => {
    const book = mkBook();
    const pos = mkPosition({ collateral: 100_000n }); // entry 32_500, price 27_000 → uPnL −169_231
    add(book, mkMarket(), [mkOrder()], [pos]);
    const items = evaluateTick(book, 15n, tick({ price: 2.7 }), NOW);
    expect(items[0]?.type).toBe("liquidate");
    expect(items).toHaveLength(2); // the increase order also fires at 2.7 (long ≤ 3.3 bound)
  });

  it("does not liquidate a healthy position", () => {
    const book = mkBook();
    add(book, mkMarket(), [], [mkPosition({ collateral: 500_000n })]);
    expect(evaluateTick(book, 15n, tick({ price: 2.7 }), NOW)).toEqual([]);
  });

  it("ignores candidates for unknown markets and null prices", () => {
    const book = mkBook();
    add(book, mkMarket(), [mkOrder()]);
    expect(evaluateTick(book, 15n, tick({ gpuId: "L40S_48GB" }), NOW)).toEqual([]);
    expect(evaluateTick(book, 15n, tick({ price: null }), NOW)).toEqual([]);
  });

  it("liquidates from debt growth alone — no price move needed", () => {
    // Position exactly at the maintenance line; an idle market with a max
    // borrow rate accrues 6_000 debt in 60s (see math.test.ts) → under.
    const book = mkBook();
    const market = mkMarket({
      borrowRatePpmPerSec: 100_000n,
      fundingUpdatedAtSec: NOW,
      openNotionalLong: 1_000_000n,
    });
    const pos = mkPosition({ collateral: 50_000n, sizeUsd: 1_000_000n, entryPrice: 32_500n });
    add(book, market, [], [pos]);
    // At the touch price with zero elapsed time: equity exactly at the line → strict < keeps it healthy.
    expect(evaluateTick(book, 15n, tick({ price: 3.25 }), NOW)).toEqual([]);
    // The same price one accrual window later: debt pushes equity under.
    const items = evaluateTick(book, 15n, tick({ price: 3.25 }), NOW + 60n);
    expect(items).toEqual([
      {
        type: "liquidate",
        wallet: pos.wallet,
        gpuId: H100,
        isLong: true,
        sku: "H100_SXM_80GB",
        reason: expect.any(String),
      },
    ]);
  });

  it("handles a size-0 decrease (full close) with its acceptable bound", () => {
    const book = mkBook();
    add(book, mkMarket(), [
      mkOrder({ kind: 1, sizeDeltaUsd: 0n, collateralDeltaUsd: 0n, acceptablePrice: 30_000n, isLong: false }),
    ]);
    // Short closes cheap (≤ 3.0000): fires.
    expect(evaluateTick(book, 15n, tick({ price: 2.9 }), NOW)).toHaveLength(1);
    // Price above the bound: stays armed.
    expect(evaluateTick(book, 15n, tick({ price: 3.1 }), NOW)).toEqual([]);
  });
});