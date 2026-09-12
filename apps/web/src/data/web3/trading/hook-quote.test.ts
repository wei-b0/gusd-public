import { describe, expect, it } from "vitest";
import { parseGpuUnits } from "@/domain/units";
import {
  issuanceGuardOk,
  oracleGuardOk,
  quoteBuyExactOutMirror,
  quoteBuyMirror,
  quoteSellExactOutMirror,
  quoteSellMirror,
  sellCapacityMirror,
  supplyForGrossBudget,
  type HookMarketState,
} from "./hook-quote";

/**
 * The mirror's arithmetic, line-checked against GPUHook.sol: the ladder's
 * POL-then-backstop order and its 2-wei headroom, the fee rounding (ceil
 * where Solidity rounds up), the R2 property that the backstop closes the
 * residual at exactly the primary's ask, the R10 cap stacking, the dust
 * thresholds (GUSD_DUST 5, GPU_DUST 1), and the guards at their boundary.
 * All figures are hand-derived from the contract's formulas at rawPrice
 * 12500 (1.25 gUSD/unit) over compositionDivisor 1e16 — if the mirror and
 * the hook ever disagree, a number here moves first.
 */

const CD = 10n ** 16n; // compositionDivisor at the fake's scales
const DENOM_BID = 12_500n * 9_950n; // rawPrice × (1e4 − bidBps)

function makeState(opts?: Partial<HookMarketState>): HookMarketState {
  return {
    rawPrice: 12_500n,
    oracleUpdatedAtSec: 0,
    hookMaxOracleStalenessSec: 10_000,
    issuanceMaxOracleStalenessSec: 10_000,
    askBps: 50,
    bidBps: 50,
    polFeeBps: 10,
    polPaused: false,
    maxPolNotionalGusd: 10n ** 24n,
    perBlockPolCapGusd: 10n ** 24n,
    perBlockUsedGusd: 0n,
    hookFeeBps: 50,
    issueFeeBps: 50,
    issuanceEnabled: true,
    compositionDivisor: CD,
    bidInventoryGusd: 10n ** 24n,
    askInventoryGpu: 10n ** 24n,
    ...opts,
  };
}

const NOW = 1_000;

describe("oracle + issuance guards", () => {
  it("fails a zero price, a future stamp, and an age past the limit", () => {
    const s = makeState();
    expect(oracleGuardOk(s, NOW)).toBe(true);
    expect(oracleGuardOk(makeState({ rawPrice: 0n }), NOW)).toBe(false);
    expect(oracleGuardOk(makeState({ oracleUpdatedAtSec: NOW + 1 }), NOW)).toBe(false);
    expect(oracleGuardOk(makeState({ hookMaxOracleStalenessSec: 999 }), NOW)).toBe(false);
    // The boundary itself passes: age == limit.
    expect(oracleGuardOk(makeState({ hookMaxOracleStalenessSec: 1_000 }), NOW)).toBe(true);
  });

  it("keeps the issuance guard independent of the hook's", () => {
    const s = makeState({ issuanceMaxOracleStalenessSec: 0 });
    expect(oracleGuardOk(s, NOW)).toBe(true); // the hook's fill path lives
    expect(issuanceGuardOk(s, NOW)).toBe(false); // the backstop leg is dead
    expect(issuanceGuardOk(makeState({ rawPrice: 0n }), NOW)).toBe(false);
  });
});

describe("quoteBuyExactOutMirror", () => {
  it("prices a pure ask fill with both fees on top", () => {
    const r = quoteBuyExactOutMirror(makeState(), parseGpuUnits(1), NOW);
    if (!r.ok) throw new Error("expected a quote");
    // polSpend = ceil(1e18 × 12500×10050 / 1e20) = 1.25625 gUSD;
    // POL fee ceil(10bps) 1.257µ; hook fee ceil(50bps) 6.282µ.
    expect(r.r.polGpu).toBe(parseGpuUnits(1));
    expect(r.r.backstopGpu).toBe(0n);
    expect(r.r.gusdIn).toBe(1_262_532n); // 1_256_250 + 6_282
    expect(r.r.polFeeGusd).toBe(1_257n);
    expect(r.r.hookFeeGusd).toBe(6_282n);
    expect(r.r.issueBase).toBe(0n);
    expect(r.r.issueFee).toBe(0n);
  });

  it("closes the residual at exactly the primary's ask (R2)", () => {
    // One unit of ask inventory, two demanded: the backstop mints the
    // shortfall at the primary's own price, so the all-in total equals
    // the pure-ask cost of the whole size — 2.5125 + hook fee.
    const r = quoteBuyExactOutMirror(makeState({ askInventoryGpu: parseGpuUnits(1) }), parseGpuUnits(2), NOW);
    if (!r.ok) throw new Error("expected a quote");
    expect(r.r.polGpu).toBe(parseGpuUnits(1));
    expect(r.r.backstopGpu).toBe(parseGpuUnits(1));
    // quoteIssue(1 unit): base = ceil(1e18×12500/1e16) = 1.25, fee = 50bps.
    expect(r.r.issueBase).toBe(1_250_000n);
    expect(r.r.issueFee).toBe(6_250n);
    expect(r.r.gusdIn).toBe(2_525_063n); // (1_256_250 + 1_256_250) + 12_563
    expect(r.r.hookFeeGusd).toBe(12_563n);
    expect(r.r.polFeeGusd).toBe(1_257n);
  });

  it("rejects a demand past the ask when the backstop is closed", () => {
    const r = quoteBuyExactOutMirror(
      makeState({ askInventoryGpu: parseGpuUnits(1), issuanceEnabled: false }),
      parseGpuUnits(2),
      NOW,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("no-ask-capacity");
    expect(r.capacityRaw).toBe(parseGpuUnits(1));
  });

  it("degrades to a rejection when only the issuance oracle is stale", () => {
    // The hook's own guard passes, issuance's doesn't: the backstop leg
    // dies (the hook's try/catch degrades it to zero) and the residual
    // exceeds dust — InsufficientMarketCapacity on-chain.
    const r = quoteBuyExactOutMirror(
      makeState({ askInventoryGpu: parseGpuUnits(1), issuanceMaxOracleStalenessSec: 0 }),
      parseGpuUnits(2),
      NOW,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("no-ask-capacity");
    expect(r.capacityRaw).toBe(parseGpuUnits(1));
  });

  it("caps the POL ask at the primary's fee (R2 effAskBps)", () => {
    // askBps 5% would price 1.3125; the primary's 50bps fee caps it at
    // 1.25625 — the backstop can always close the residual exactly.
    const r = quoteBuyExactOutMirror(makeState({ askBps: 500 }), parseGpuUnits(1), NOW);
    if (!r.ok) throw new Error("expected a quote");
    expect(r.r.gusdIn).toBe(1_262_532n);
  });

  it("binds the per-block POL cap and shifts the rest to the backstop", () => {
    // perBlock remaining 1 gUSD at the ask edge buys floor(1e6×1e20/
    // 1.25625e8) ≈ 0.796019801980198019801 units; the rest mints.
    const left = 1_000_000n;
    const capGpu = (left * 10n ** 20n) / DENOM_ASK_FOR(50);
    const r = quoteBuyExactOutMirror(
      makeState({ perBlockPolCapGusd: 1_000_000n }),
      parseGpuUnits(2),
      NOW,
    );
    if (!r.ok) throw new Error("expected a quote");
    expect(r.r.polGpu).toBe(capGpu);
    expect(r.r.backstopGpu).toBe(parseGpuUnits(2) - capGpu);
  });
});

/** The hook's ask denominator at `askBps` — rawPrice × (1e4 + bps). */
function DENOM_ASK_FOR(askBps: number): bigint {
  return 12_500n * BigInt(10_000 + askBps);
}

describe("quoteBuyMirror (exact-in)", () => {
  it("charges the hook fee off the top and spends exactly the typed amount", () => {
    // Zero-fee shape for exact division: rawPrice 1.00, all spreads 0.
    const s = makeState({
      rawPrice: 10_000n,
      askBps: 0,
      bidBps: 0,
      polFeeBps: 0,
      hookFeeBps: 0,
      issueFeeBps: 0,
    });
    const r = quoteBuyMirror(s, 5_000_000n, NOW);
    if (!r.ok) throw new Error("expected a quote");
    expect(r.r.gusdIn).toBe(5_000_000n); // the typed spend itself
    expect(r.r.gpuOut).toBe(parseGpuUnits(5)); // floor(5e6×1e20/1e8)
    expect(r.r.polGpu).toBe(parseGpuUnits(5));
    expect(r.r.hookFeeGusd).toBe(0n);
  });

  it("takes the hook fee out of the absorbed budget", () => {
    const s = makeState();
    // 10 gUSD spend → hook fee ceil(50bps) = 50_000µ → budget 9_950_000µ.
    const r = quoteBuyMirror(s, 10_000_000n, NOW);
    if (!r.ok) throw new Error("expected a quote");
    expect(r.r.gusdIn).toBe(10_000_000n);
    expect(r.r.hookFeeGusd).toBe(50_000n);
    // The affordable ask leg: floor(budget×1e20/denomAsk) — computed here
    // from the contract's own formula, not from the mirror.
    const affordable = (9_950_000n * 10n ** 20n) / DENOM_ASK_FOR(50);
    expect(r.r.polGpu).toBe(affordable);
    expect(r.r.gpuOut).toBe(r.r.polGpu + r.r.backstopGpu);
    expect(r.r.polGpu + r.r.backstopGpu).toBe(r.r.gpuOut);
  });

  it("degrades to the POL leg when issuance is closed", () => {
    const s = makeState({ issuanceEnabled: false });
    const r = quoteBuyMirror(s, 10_000_000n, NOW);
    if (!r.ok) throw new Error("expected a quote");
    const affordable = (9_950_000n * 10n ** 20n) / DENOM_ASK_FOR(50);
    expect(r.r.polGpu).toBe(affordable);
    expect(r.r.backstopGpu).toBe(0n);
    // And a dry book with issuance closed is the only buy rejection: the
    // plan never reverts on capacity for this shape — it fills the budget.
    const dry = quoteBuyMirror(makeState({ issuanceEnabled: false, askInventoryGpu: 0n }), 10_000_000n, NOW);
    expect(dry.ok).toBe(false);
    if (dry.ok) return;
    expect(dry.reason).toBe("no-ask-capacity");
    expect(dry.capacityRaw).toBe(0n);
  });
});

describe("quoteSellMirror (exact-in)", () => {
  it("nets both fees off the gross bid proceeds", () => {
    const r = quoteSellMirror(makeState(), parseGpuUnits(1), NOW);
    if (!r.ok) throw new Error("expected a quote");
    // gross = floor(1e18 × 12500×9950 / 1e20) = 1.24375 gUSD;
    // POL fee ceil(10bps) 1.244µ off the gross; hook fee ceil(50bps)
    // 6.213µ off the net → 1.236293 to the seller.
    expect(r.r.gpuIn).toBe(parseGpuUnits(1));
    expect(r.r.gusdOut).toBe(1_236_293n);
    expect(r.r.polFeeGusd).toBe(1_244n);
    expect(r.r.hookFeeGusd).toBe(6_213n);
  });

  it("absorbs one GPU-wei of dust unpaid", () => {
    // Bid float prices exactly 2 units; selling 2 units + 1 wei leaves a
    // 1-wei residual the vault eats so the ledger closes — the seller is
    // paid for the expressible fill only, gpuIn stays the full size.
    const s = makeState({ bidInventoryGusd: 2_487_500n });
    const r = quoteSellMirror(s, parseGpuUnits(2) + 1n, NOW);
    if (!r.ok) throw new Error("expected a quote");
    expect(r.r.polGpu).toBe(parseGpuUnits(2));
    expect(r.r.gusdOut).toBe(2_472_586n); // the 2-unit net, not 2.0000001
    expect(r.r.gpuIn).toBe(parseGpuUnits(2) + 1n);
  });

  it("rejects beyond capacity with the max sellable size", () => {
    const s = makeState({ bidInventoryGusd: 2_000_000n });
    const r = quoteSellMirror(s, parseGpuUnits(5), NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("no-bid-capacity");
    // The capacity is the same figure sellCapacityMirror quotes — the
    // slip's MAX button and the rejection agree by construction.
    expect(r.capacityRaw).toBe(sellCapacityMirror(s, NOW).maxUnitsRaw);
    expect(r.capacityRaw).toBeLessThan(parseGpuUnits(5));
    expect(r.capacityRaw).toBeGreaterThan(parseGpuUnits(1));
  });

  it("binds the per-block POL cap before the vault float", () => {
    // 1 gUSD of per-block headroom left, 900µ already used.
    const s = makeState({
      perBlockPolCapGusd: 1_000_000n,
      perBlockUsedGusd: 900_000n,
    });
    const r = quoteSellMirror(s, parseGpuUnits(2), NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("no-bid-capacity");
    expect(r.capacityRaw).toBe((100_000n * 10n ** 20n) / DENOM_BID);
    expect(r.capacityRaw!).toBeLessThan(parseGpuUnits(1));
  });
});

describe("quoteSellExactOutMirror (proceeds-first)", () => {
  it("solves the gross units the seller must bear for the demanded payout", () => {
    const r = quoteSellExactOutMirror(makeState(), 2_000_000n, NOW);
    if (!r.ok) throw new Error("expected a quote");
    expect(r.r.gusdOut).toBe(2_000_000n); // exactly the typed demand
    // polFee ceil(10bps) 2_000µ + hook fee ceil(50bps) 10_000µ ride inside
    // the gross: 2_012_000µ at the bid edge.
    expect(r.r.polFeeGusd).toBe(2_000n);
    expect(r.r.hookFeeGusd).toBe(10_000n);
    const gross = 2_012_000n;
    // ceil(2_012_000µ × 1e20 / 124_375_000) — 1.6177 GPU at the bid edge.
    expect(r.r.gpuIn).toBe(1_617_688_442_211_055_277n);
    expect(r.r.gpuIn).toBeGreaterThan(parseGpuUnits(1.6));
  });

  it("carries the max payout when the float can't net the demand", () => {
    // 2 gUSD of float can't net 2 gUSD after the seller's fees — the
    // largest net payout the float covers is 1.988070 gUSD.
    const r = quoteSellExactOutMirror(makeState({ bidInventoryGusd: 2_000_000n }), 2_000_000n, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("no-bid-capacity");
    expect(r.capacityRaw).toBe(1_988_070n);
  });

  it("absorbs five gUSD-wei of dust on the proceeds demand", () => {
    // Demanding 5 wei past the float still fills: the vault shrugs off
    // GUSD_DUST; anything wider reverts.
    const s = makeState({ bidInventoryGusd: 2_000_000n });
    const r = quoteSellExactOutMirror(s, 1_988_070n + 5n, NOW);
    expect(r.ok).toBe(true);
    const r2 = quoteSellExactOutMirror(s, 1_988_070n + 6n, NOW);
    expect(r2.ok).toBe(false);
  });
});

describe("supplyForGrossBudget + sellCapacityMirror", () => {
  it("shrinks the overshooting estimate into the budget", () => {
    // Initial estimate overshoots by one ceil-wei of fee; one shrink step
    // lands exactly inside.
    expect(supplyForGrossBudget(2_000_000n, 10, 50)).toBe(1_988_070n);
    expect(supplyForGrossBudget(0n, 10, 50)).toBe(0n);
    expect(supplyForGrossBudget(2_000_000n, 0, 0)).toBe(2_000_000n);
    // A budget below one fee-wei of supply quotes zero, never negative.
    expect(supplyForGrossBudget(1n, 10, 50)).toBe(0n);
  });

  it("quotes the two-sided capacity the slip's MAX uses", () => {
    // Per-block headroom of 1_243_750 gUSD at the bid edge prices exactly
    // 1 whole GPU of units capacity: 1_243_750×1e20/124375000 = 1e18.
    const s = makeState({ perBlockPolCapGusd: 1_243_750n });
    const cap = sellCapacityMirror(s, NOW);
    expect(cap.maxUnitsRaw).toBe(parseGpuUnits(1));
    // The proceeds side: the float nets 1_236_331 after both fees.
    expect(cap.maxProceedsRaw).toBe(1_236_331n);
    // A stale oracle is no market at all.
    const stale = sellCapacityMirror(makeState({ hookMaxOracleStalenessSec: 0 }), NOW);
    expect(stale.maxUnitsRaw).toBe(0n);
    expect(stale.maxProceedsRaw).toBe(0n);
  });
});

