/**
 * PerpClaimable projection regression (audit T0-7 / H1) — network-free.
 *
 * The engine credits trader claimables through ONE chokepoint
 * (`_creditClaimable` → ClaimableSettled on every close-proceeds path:
 * partial-close `due`, full-close `due`, trigger fills, liquidation `due`)
 * and debits them by Claimed.paid. Earned funding does NOT touch the
 * counter — it accrues into the position's own `earnedFunding` balance,
 * carried absolutely on the Position events. This suite replays that
 * trajectory through the real handlers — envio is mocked out so
 * `indexer.onEvent` captures the registrations, and the handlers run against
 * an in-memory entity store via the production createDb semantics (the
 * captured wrapper builds the db) — and asserts the projected balance equals
 * `engine.claimableOf` at every step:
 *
 *   +5 increase-time funding credit lands in PerpPosition.earnedFunding
 *   (claimable UNCHANGED) → +100 decrease due → +50 liquidation due →
 *   −30 claim = 120 — never 2× (the pre-H1 bug folded
 *   OrderExecuted.claimableDelta in on top of ClaimableSettled, which
 *   doubled every decrease/credit).
 *
 * Money fields are asserted native BigInt on the read-back row, pinning the
 * money-stays-BigInt bigintNumbers doctrine.
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ registry: new Map<string, (x: any) => Promise<void>>() }));

vi.mock("envio", () => ({
  indexer: {
    // envio-compat's register() forwards here — capture instead of consume.
    onEvent: (spec: { contract: string; event: string }, fn: (x: any) => Promise<void>) => {
      h.registry.set(`${spec.contract}:${spec.event}`, fn);
    },
    contractRegister: () => {},
  },
}));

// Import registers every perp handler into the captured registry.
import "../handlers/perp.js";

const ENGINE = "0x4ed7c70f96b99c776995fb64377f0d4ab3b0e1c1"; // GpuPerpEngine
const ALICE = "0xf39fd6e51aad88f4ce6ab8827279cfffb92266";
const BOB = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const H100 = "0x4831303000000000000000000000000000000000000000000000000000000000"; // "H100"
const TX = `0x${"ab".repeat(32)}`;

/** In-memory entity store with the get/set surface createDb consumes — the
 *  captured handler wrapper wraps it, so the production bigintNumbers ↔
 *  Number round-trip applies exactly as in the live indexer. */
function makeContext() {
  const store = new Map<string, Record<string, any>>();
  const cache = new Map<string, { get(id: string): Promise<Record<string, any> | undefined>; set(v: Record<string, any>): void }>();
  const ops = (entity: string) => ({
    async get(id: string) {
      const v = store.get(`${entity}:${id}`);
      return v === undefined ? undefined : { ...v };
    },
    set(value: Record<string, any>) {
      store.set(`${entity}:${value.id}`, value);
    },
  });
  const context: any = new Proxy(
    { chain: { id: 31337 }, isPreload: false },
    {
      get(target, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop in target) return (target as any)[prop];
        if (!cache.has(prop)) cache.set(prop, ops(prop));
        return cache.get(prop);
      },
    },
  );
  return { context, store };
}

/** Deliver one decoded log to its registered handler (the same envioEvent
 *  shape envio-compat's wrapper reconstructs from the wire event). */
async function deliver(
  contract: string,
  event: string,
  params: Record<string, any>,
  logIndex: number,
  blockNumber: bigint,
  blockTimestamp: bigint,
  { context }: { context: any },
) {
  const fn = h.registry.get(`${contract}:${event}`);
  if (!fn) throw new Error(`no handler registered for ${contract}:${event}`);
  await fn({
    event: {
      params,
      block: { number: blockNumber, timestamp: blockTimestamp },
      transaction: { hash: TX },
      logIndex,
      srcAddress: ENGINE,
    },
    context,
  });
}

const claimableRow = (store: Map<string, Record<string, any>>, wallet: string) =>
  store.get(`PerpClaimable:${wallet}`);

describe("PerpClaimable accrues from ClaimableSettled alone (H1)", () => {
  it("tracks the engine's claimableOf trajectory without double-counting", async () => {
    const { context, store } = makeContext();

    // --- 1. Increase touch that earns a funding credit (+5): the engine does
    // NOT touch claimable — the credit accrues into the position's
    // earnedFunding balance (PositionIncreased carries it absolutely;
    // OrderExecuted.claimableDelta is 0 on increases).
    await deliver("GpuPerpEngine", "PositionIncreased", {
      account: BOB,
      gpuId: H100,
      isLong: true,
      newSizeUsd: 200_000_000n,
      newCollateral: 19_800_000n,
      newEntryPrice: 25_000n,
      fundingFeeCheckpoint: 0n,
      fundingCreditCheckpoint: 0n,
      borrowCheckpoint: 0n,
      newEarnedFunding: 5n,
    }, 1, 100n, 1_000n, { context });
    await deliver("GpuPerpEngine", "OrderExecuted", {
      orderId: 1n,
      executor: BOB,
      account: BOB,
      gpuId: H100,
      kind: 0n, // MarketIncrease
      isLong: true,
      execPrice: 25_000n,
      executionFeePaid: 20_000n,
      sizeDeltaUsd: 200_000_000n,
      realizedPnl: 0n,
      feesPaid: 20_000n,
      fundingNet: 5n,
      claimableDelta: 0n,
    }, 2, 100n, 1_000n, { context });

    // The earned credit lives on the POSITION row, never the balance.
    const positionAfterIncrease = store.get(`PerpPosition:${BOB}_${H100}_true`);
    expect(positionAfterIncrease).toMatchObject({ earnedFunding: 5n });
    // No ClaimableSettled fires on an increase — the balance projection
    // stays absent (pre-redesign this read 5n via an increase-time credit).
    expect(claimableRow(store, BOB)).toBeUndefined();

    // --- 2. Decrease that settles +100 to claimable (close proceeds — the
    // earned balance folded into the settlement, so the position row's
    // earnedFunding drains to 0 with the full close).
    await deliver("GpuPerpEngine", "PositionDecreased", {
      account: BOB,
      gpuId: H100,
      isLong: true,
      sizeDeltaUsd: 200_000_000n,
      realizedPnl: 0n,
      fundingNet: 100n,
      closeFee: 20_000n,
      claimableDelta: 100n,
      remainingSizeUsd: 0n,
      remainingCollateral: 0n,
      fundingFeeCheckpoint: 0n,
      fundingCreditCheckpoint: 0n,
      borrowCheckpoint: 0n,
      remainingEarnedFunding: 0n,
    }, 1, 110n, 1_100n, { context });
    await deliver("GpuPerpEngine", "OrderExecuted", {
      orderId: 2n,
      executor: BOB,
      account: BOB,
      gpuId: H100,
      kind: 1n, // MarketDecrease
      isLong: true,
      execPrice: 25_000n,
      executionFeePaid: 20_000n,
      sizeDeltaUsd: 200_000_000n,
      realizedPnl: 0n,
      feesPaid: 20_000n,
      fundingNet: 100n,
      claimableDelta: 100n,
    }, 2, 110n, 1_100n, { context });
    await deliver("GpuPerpEngine", "ClaimableSettled", {
      account: BOB, gpuId: H100, amount: 100n,
    }, 3, 110n, 1_100n, { context });

    expect(claimableRow(store, BOB)).toMatchObject({ balance: 100n, totalSettled: 100n, settleCount: 1n });
    expect(store.get(`PerpPosition:${BOB}_${H100}_true`)).toMatchObject({ earnedFunding: 0n });

    // --- 3. Liquidation due +50 (this path was correct pre-H1 — the
    // PositionLiquidated delta was already skipped).
    await deliver("GpuPerpEngine", "PositionLiquidated", {
      account: BOB,
      gpuId: H100,
      isLong: true,
      executor: ALICE,
      execPrice: 20_000n,
      liquidationFee: 1_000_000n,
      badDebt: 0n,
      claimableDelta: 50n,
    }, 1, 120n, 1_200n, { context });
    await deliver("GpuPerpEngine", "ClaimableSettled", {
      account: BOB, gpuId: H100, amount: 50n,
    }, 2, 120n, 1_200n, { context });

    expect(claimableRow(store, BOB)).toMatchObject({ balance: 150n, settleCount: 2n });
    // Liquidation stamps the position row, never the balance twice.
    const position = store.get(`PerpPosition:${BOB}_${H100}_true`);
    expect(position).toMatchObject({ sizeUsd: 0n, liquidatedAtSec: 1200n });

    // --- 4. Claim pays 30 — the engine decrements claimableOf by PAID.
    await deliver("GpuPerpEngine", "Claimed", {
      account: BOB, to: BOB, requested: 150n, paid: 30n,
    }, 1, 130n, 1_300n, { context });

    expect(claimableRow(store, BOB)).toMatchObject({
      balance: 120n,
      totalSettled: 150n,
      totalClaimed: 30n,
      settleCount: 2n,
      claimCount: 1n,
    });
    // Money stays native BigInt through the read-back (never in
    // bigintNumbers) — the exact delta math depends on it.
    const row = claimableRow(store, BOB)!;
    expect(typeof row.balance).toBe("bigint");
    const stats = store.get("PerpEngineStats:engine");
    expect(stats!.claimedGusd).toBe(30n);
  });

  it("ignores zero-amount ClaimableSettled rows", async () => {
    const { context, store } = makeContext();
    await deliver("GpuPerpEngine", "ClaimableSettled", {
      account: ALICE, gpuId: H100, amount: 0n,
    }, 1, 140n, 1_400n, { context });
    expect(claimableRow(store, ALICE)).toBeUndefined();
  });
});
