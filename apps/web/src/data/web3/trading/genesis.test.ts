import { describe, expect, it, vi } from "vitest";
import { GPU_LEDGER_GRAIN } from "@/domain/units";
import { issueUnitsForSpend, type IssueQuoteRaw } from "./genesis";

/**
 * The genesis spend solver, against the contract's own ceil math: base =
 * ceil(u × price / 1e16), fee = ceil(base × feeBps / 1e4) — the same
 * formulas the issuance contract runs, so every expected total here is a
 * number the chain would quote back. The fake is a pure closure over one
 * (price, feeBps) pair; call counts expose how the solve actually walked.
 */

/** The issuance contract's math at (price4dp, feeBps), as a fake seam. */
function makeIssue(price4dp: bigint, feeBps: number) {
  const calls: bigint[] = [];
  const issue = vi.fn(async (amountRaw: bigint): Promise<IssueQuoteRaw> => {
    calls.push(amountRaw);
    const base = (amountRaw * price4dp + 10n ** 16n - 1n) / 10n ** 16n;
    const fee = (base * BigInt(feeBps) + 9_999n) / 10_000n;
    return { base, fee, total: base + fee };
  });
  return { issue, calls };
}

describe("issueUnitsForSpend", () => {
  it("returns the exact fit when the spend lands on the boundary", async () => {
    // 2 units at 1.25 gUSD + 50bps = 2.5125 gUSD exactly.
    const { issue } = makeIssue(12500n, 50);
    const solved = await issueUnitsForSpend(2_512_500n, 12500n, 50, issue);
    expect(solved).not.toBeNull();
    expect(solved!.units).toBe(2_000_000_000_000_000_000n);
    expect(solved!.quote.total).toBe(2_512_500n);
  });

  it("is maximal: the next grain never fits", async () => {
    // 10 gUSD at 1.25/unit + 50bps fits 7.9601 units (9.999875625 gUSD);
    // 7.9602 units cost 10.00000125 — over. The seed alone overshoots
    // (ceil granularity), so this exercises the refinement and the walk.
    const { issue } = makeIssue(12500n, 50);
    const solved = await issueUnitsForSpend(10_000_000n, 12500n, 50, issue);
    expect(solved).not.toBeNull();
    expect(solved!.units).toBe(7_960_100_000_000_000_000n);
    expect(solved!.quote.total).toBeLessThanOrEqual(10_000_000n);
    // Maximality is real, not an artifact of stopping early.
    const { issue: probe } = makeIssue(12500n, 50);
    const oneMore = await probe(solved!.units + GPU_LEDGER_GRAIN);
    expect(oneMore.total).toBeGreaterThan(10_000_000n);
  });

  it("always returns a multiple of the ledger grain", async () => {
    const { issue } = makeIssue(25_137n, 125);
    const solved = await issueUnitsForSpend(3_141_592n, 25_137n, 125, issue);
    expect(solved).not.toBeNull();
    expect(solved!.units % GPU_LEDGER_GRAIN).toBe(0n);
    expect(solved!.quote.total).toBeLessThanOrEqual(3_141_592n);
  });

  it("refuses a spend that cannot reach one grain of units", async () => {
    // One grain (1e-4 units) at 1.25/unit + 50bps costs ~125.0125 micro-gUSD.
    const { issue } = makeIssue(12500n, 50);
    expect(await issueUnitsForSpend(1n, 12500n, 50, issue)).toBeNull();
  });

  it("refuses a zero price — the oracle published nothing", async () => {
    const { issue } = makeIssue(12500n, 50);
    expect(await issueUnitsForSpend(10_000_000n, 0n, 50, issue)).toBeNull();
  });

  it("refuses when the chain answers an empty quote", async () => {
    // total = 0 is the contract's "no publication" — never a fillable solve.
    const issue = vi.fn(async (): Promise<IssueQuoteRaw> => ({ base: 0n, fee: 0n, total: 0n }));
    expect(await issueUnitsForSpend(10_000_000n, 12500n, 50, issue)).toBeNull();
  });

  it("refuses a solve that still overspends after the bounded walk", async () => {
    // A quote that ignores its input can't be walked into the spend.
    const issue = vi.fn(async (): Promise<IssueQuoteRaw> => ({
      base: 20_000_000n,
      fee: 1_000_000n,
      total: 21_000_000n,
    }));
    expect(await issueUnitsForSpend(10_000_000n, 12500n, 50, issue)).toBeNull();
  });

  it("refuses a non-positive spend outright", async () => {
    const { issue } = makeIssue(12500n, 50);
    expect(await issueUnitsForSpend(0n, 12500n, 50, issue)).toBeNull();
    expect(issue).not.toHaveBeenCalled();
  });
});
