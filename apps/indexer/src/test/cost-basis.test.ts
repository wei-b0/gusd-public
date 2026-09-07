/**
 * Pure WAC cost-basis math + transfer-leg math (rev 2 policy): acquisitions
 * accumulate qty/cost, disposals realize only in complete state, raw
 * transfers demote completeness and never move basis. All values are raw
 * onchain units (GPU 18-dec, gUSD 6-dec) — scaling to human units happens
 * at the API boundary, never here.
 */
import { describe, expect, it } from "vitest";
import {
  acquireBasis,
  demoteBasis,
  demoteVault,
  depositVault,
  disposeBasis,
  emptyBasis,
  emptyVault,
  mulDivFloor,
  withdrawVault,
  type BasisSnapshot,
} from "../projections/cost-basis.js";
import { ZERO_ADDRESS, balanceChanges } from "../projections/balances.js";

const GUSD = 6n; // decimals as a power for readability below
const GPU = 18n;
const g = (n: bigint): bigint => n * 10n ** GUSD;
const gpu = (n: bigint): bigint => n * 10n ** GPU;

describe("mulDivFloor", () => {
  it("divides exactly", () => {
    expect(mulDivFloor(300n, 7n, 3n)).toBe(700n);
  });

  it("floors truncated results (bigint division truncates toward zero)", () => {
    expect(mulDivFloor(1n, 1n, 3n)).toBe(0n);
    expect(mulDivFloor(10n, 1n, 3n)).toBe(3n);
    expect(mulDivFloor(-0n, 5n, 2n)).toBe(0n);
  });

  it("returns zero for a zero denominator", () => {
    expect(mulDivFloor(5n, 5n, 0n)).toBe(0n);
  });
});

describe("balanceChanges", () => {
  const alice = "0x0000000000000000000000000000000000000001" as const;

  it("credits only the receiver on a mint", () => {
    expect(balanceChanges({ from: ZERO_ADDRESS as `0x${string}`, to: alice, value: g(5n) })).toEqual([
      { wallet: alice, delta: g(5n) },
    ]);
  });

  it("debits only the sender on a burn", () => {
    expect(balanceChanges({ from: alice, to: ZERO_ADDRESS as `0x${string}`, value: g(2n) })).toEqual([
      { wallet: alice, delta: -g(2n) },
    ]);
  });

  it("yields two opposing legs on a normal transfer", () => {
    const bob = "0x0000000000000000000000000000000000000002" as const;
    expect(balanceChanges({ from: alice, to: bob, value: g(3n) })).toEqual([
      { wallet: alice, delta: -g(3n) },
      { wallet: bob, delta: g(3n) },
    ]);
  });

  it("nets a self-transfer to zero across two legs", () => {
    const legs = balanceChanges({ from: alice, to: alice, value: g(1n) });
    expect(legs).toHaveLength(2);
    expect(legs.reduce((sum, l) => sum + l.delta, 0n)).toBe(0n);
  });

  it("yields no legs for a zero-to-zero transfer", () => {
    expect(
      balanceChanges({ from: ZERO_ADDRESS as `0x${string}`, to: ZERO_ADDRESS as `0x${string}`, value: g(1n) }),
    ).toEqual([]);
  });
});

describe("acquireBasis", () => {
  it("starts from an empty snapshot", () => {
    const next = acquireBasis(emptyBasis(), gpu(100n), 251250000n); // 251.25 gUSD
    expect(next.qtyGpu).toBe(gpu(100n));
    expect(next.costGusd).toBe(251250000n);
    expect(next.acquisitions).toBe(1);
    expect(next.basisState).toBe("complete");
  });

  it("accumulates across acquisitions and preserves realized/state", () => {
    const first = acquireBasis(emptyBasis(), gpu(100n), g(251n));
    const second = acquireBasis(first, gpu(50n), g(150n));
    expect(second.qtyGpu).toBe(gpu(150n));
    expect(second.costGusd).toBe(g(401n));
    expect(second.acquisitions).toBe(2);
    expect(second.realizedPnlGusd).toBe(0n);
  });
});

describe("disposeBasis (WAC)", () => {
  const acquired = (): BasisSnapshot =>
    acquireBasis(
      acquireBasis(emptyBasis(), gpu(100n), 251250000n), // 251.25 gUSD
      gpu(50n),
      150000000n, // 150 gUSD
    );

  it("realizes proceeds minus attributed cost, in complete state", () => {
    // qty 150 GPU, cost 401.25 gUSD → disposing 30 GPU attributes 80.25.
    const b = acquired();
    const next = disposeBasis(b, gpu(30n), g(90n));
    expect(next.qtyGpu).toBe(gpu(120n));
    expect(next.costGusd).toBe(321000000n); // 401.25 − 80.25
    expect(next.realizedPnlGusd).toBe(9750000n); // 90 − 80.25
    expect(next.disposals).toBe(1);
    expect(next.basisState).toBe("complete");
  });

  it("records a loss when proceeds are below attributed cost", () => {
    const next = disposeBasis(acquired(), gpu(30n), g(50n));
    expect(next.realizedPnlGusd).toBe(50000000n - 80250000n); // 50 − 80.25
  });

  it("clamps take to the held qty (over-disposal never goes negative)", () => {
    const b = acquireBasis(emptyBasis(), gpu(10n), g(20n));
    const next = disposeBasis(b, gpu(99n), g(30n));
    expect(next.qtyGpu).toBe(0n);
    expect(next.costGusd).toBe(0n);
    expect(next.realizedPnlGusd).toBe(g(30n) - g(20n));
  });

  it("does nothing but count when the basis is partial", () => {
    const b = demoteBasis(acquired());
    const next = disposeBasis(b, gpu(30n), g(90n));
    expect(next.qtyGpu).toBe(b.qtyGpu);
    expect(next.costGusd).toBe(b.costGusd);
    expect(next.realizedPnlGusd).toBe(b.realizedPnlGusd);
    expect(next.disposals).toBe(1);
  });

  it("does nothing but count on a zero-qty basis", () => {
    const next = disposeBasis(emptyBasis(), gpu(5n), g(1n));
    expect(next.qtyGpu).toBe(0n);
    expect(next.costGusd).toBe(0n);
    expect(next.realizedPnlGusd).toBe(0n);
    expect(next.disposals).toBe(1);
  });
});

describe("demoteBasis", () => {
  it("flips complete to partial, moving nothing else", () => {
    const b = acquireBasis(emptyBasis(), gpu(10n), g(5n));
    const next = demoteBasis(b);
    expect(next.basisState).toBe("partial");
    expect(next.qtyGpu).toBe(b.qtyGpu);
    expect(next.costGusd).toBe(b.costGusd);
    expect(next.realizedPnlGusd).toBe(b.realizedPnlGusd);
  });

  it("is monotone — partial stays partial", () => {
    expect(demoteBasis(demoteBasis(emptyBasis())).basisState).toBe("partial");
  });
});

describe("vault position", () => {
  it("accumulates deposits as assets-in for shares-minted", () => {
    const v = depositVault(depositVault(emptyVault(), g(100n), g(98n)), g(50n), g(48n));
    expect(v.shares).toBe(g(146n));
    expect(v.assetsCost).toBe(g(150n));
    expect(v.deposits).toBe(2);
  });

  it("realizes withdrawals against the burned shares' average cost", () => {
    // 150 shares carrying 150 gUSD cost → burning 30 attributes 30.
    const v = depositVault(emptyVault(), g(150n), g(150n));
    const next = withdrawVault(v, g(32n), g(30n));
    expect(next.shares).toBe(g(120n));
    expect(next.assetsCost).toBe(g(120n));
    expect(next.realizedPnlGusd).toBe(g(2n));
    expect(next.withdraws).toBe(1);
  });

  it("burns shares without touching cost when partial", () => {
    const v = demoteVault(depositVault(emptyVault(), g(150n), g(150n)));
    const next = withdrawVault(v, g(32n), g(30n));
    expect(next.shares).toBe(g(120n)); // share count stays real
    expect(next.assetsCost).toBe(g(150n)); // cost frozen — unattributable
    expect(next.realizedPnlGusd).toBe(0n);
  });

  it("clamps burn to held shares", () => {
    const v = depositVault(emptyVault(), g(100n), g(100n));
    const next = withdrawVault(v, g(500n), g(200n));
    expect(next.shares).toBe(0n);
    expect(next.assetsCost).toBe(0n);
    expect(next.realizedPnlGusd).toBe(g(500n) - g(100n));
  });
});
