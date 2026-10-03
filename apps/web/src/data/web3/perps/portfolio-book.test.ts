import { describe, expect, it } from "vitest";
import {
  allLiveMarked,
  anyUnknown,
  carryMark,
  emptyProbes,
  liveRows,
  mergeProbe,
  openFromProbes,
  perpEquitySum,
  portfolioEquity,
  positionOf,
  type PerpProbeMap,
} from "./portfolio-book";
import type { PerpBookRow } from "./portfolio-book";
import type { PerpPositionState } from "@/domain/types";

/** A fully-marked long as the port's verified view would return it. */
function marked(overrides: Partial<PerpPositionState> = {}): PerpPositionState {
  return {
    asset: "H100",
    side: "long",
    sizeUsd: 50,
    collateral: 10,
    entryPrice: 2.5,
    earnedFunding: 0,
    markPrice: 2.6,
    uPnl: 2,
    equity: 11.5,
    maintenance: 1.25,
    liquidatable: false,
    fundingNet: -0.1,
    liquidationPrice: 2.1,
    updatedAt: 1000,
    markedAt: 1000,
    ...overrides,
  };
}

/** The same position during a report gap — raw figures, no mark. */
function unmarked(overrides: Partial<PerpPositionState> = {}): PerpPositionState {
  return marked({ markPrice: null, uPnl: null, equity: null, maintenance: null, liquidatable: null, fundingNet: null, liquidationPrice: null, markedAt: null, ...overrides });
}

describe("positionOf", () => {
  it("returns the position for ok and unmarked probes", () => {
    expect(positionOf({ kind: "ok", position: marked() })).toEqual(marked());
    expect(positionOf({ kind: "unmarked", position: unmarked() })).toEqual(unmarked());
  });

  it("is null for flat and unknown — flat means the read saw zero, unknown means nothing", () => {
    expect(positionOf({ kind: "flat" })).toBeNull();
    expect(positionOf({ kind: "unknown" })).toBeNull();
  });
});

describe("carryMark", () => {
  it("keeps the previous mark's timestamp across a report gap", () => {
    const prev = { kind: "ok", position: marked({ markedAt: 900 }) } as const;
    const next = carryMark({ kind: "unmarked", position: unmarked() }, prev);
    expect(next.kind).toBe("unmarked");
    if (next.kind !== "unmarked") throw new Error("unreachable");
    expect(next.position.markedAt).toBe(900);
  });

  it("replaces ok probes wholesale and leaves a never-marked read null", () => {
    const ok = { kind: "ok", position: marked() } as const;
    expect(carryMark(ok, { kind: "unknown" })).toBe(ok);
    const next = carryMark({ kind: "unmarked", position: unmarked() }, { kind: "unknown" });
    if (next.kind !== "unmarked") throw new Error("unreachable");
    expect(next.position.markedAt).toBeNull();
  });
});

describe("mergeProbe", () => {
  it("unknown never erases a known row", () => {
    const known = { kind: "ok", position: marked() } as const;
    expect(mergeProbe({ kind: "unknown" }, known)).toBe(known);
  });

  it("a fresh unmarked read keeps the prior mark age", () => {
    const prev = { kind: "ok", position: marked({ markedAt: 900 }) } as const;
    const next = mergeProbe({ kind: "unmarked", position: unmarked() }, prev);
    expect(next.kind).toBe("unmarked");
    if (next.kind !== "unmarked") throw new Error("unreachable");
    expect(next.position.markedAt).toBe(900);
  });
});

describe("liveRows", () => {
  it("orders by the panels' asset order with long before short", () => {
    const probes: PerpProbeMap = {
      ...emptyProbes(),
      L40S: { long: { kind: "ok", position: marked({ asset: "L40S", equity: 5 }) }, short: { kind: "flat" } },
      H100: { long: { kind: "flat" }, short: { kind: "ok", position: marked({ asset: "H100", side: "short", equity: 3 }) } },
      H200: { long: { kind: "ok", position: marked({ asset: "H200", equity: 4 }) }, short: { kind: "flat" } },
    };
    expect(liveRows(probes).map((r) => `${r.asset}/${r.side}`)).toEqual([
      "H100/short",
      "H200/long",
      "L40S/long",
    ]);
  });
});

describe("book marking gates", () => {
  it("anyUnknown flags unresolved existence and clears once every probe answers", () => {
    const probes = emptyProbes();
    expect(anyUnknown(probes)).toBe(true);
    const full: PerpProbeMap = { ...probes };
    for (const asset of Object.keys(full) as (keyof PerpProbeMap)[]) {
      full[asset] = { long: { kind: "flat" }, short: { kind: "flat" } };
    }
    expect(anyUnknown(full)).toBe(false);
  });

  it("allLiveMarked requires rows and a mark on each", () => {
    expect(allLiveMarked([])).toBe(false);
    expect(allLiveMarked([{ asset: "H100", side: "long", position: marked() }])).toBe(true);
    expect(allLiveMarked([{ asset: "H100", side: "long", position: unmarked() }])).toBe(false);
  });

  it("perpEquitySum is null while any live row is unmarked, else the exact sum", () => {
    const rows: PerpBookRow[] = [
      { asset: "H100", side: "long", position: marked({ equity: 11.5 }) },
      { asset: "H200", side: "short", position: marked({ equity: -2.5 }) },
    ];
    expect(perpEquitySum(rows)).toBe(9);
    const [first, second] = rows;
    if (first === undefined || second === undefined) throw new Error("unreachable");
    expect(perpEquitySum([first, { ...second, position: unmarked({}) }])).toBeNull();
  });
});

describe("openFromProbes — the claim gate", () => {
  it("null while existence is unresolved, live rows → true, all flat → false", () => {
    const probes = emptyProbes();
    expect(openFromProbes(probes)).toBeNull();
    const oneOpen: PerpProbeMap = { ...emptyProbes() };
    for (const asset of Object.keys(oneOpen) as (keyof PerpProbeMap)[]) {
      oneOpen[asset] = {
        long: asset === "H100" ? { kind: "ok", position: marked() } : { kind: "flat" },
        short: { kind: "flat" },
      };
    }
    expect(openFromProbes(oneOpen)).toBe(true);
    const flat: PerpProbeMap = { ...emptyProbes() };
    for (const asset of Object.keys(flat) as (keyof PerpProbeMap)[]) {
      flat[asset] = { long: { kind: "flat" }, short: { kind: "flat" } };
    }
    expect(openFromProbes(flat)).toBe(false);
  });
});

describe("portfolioEquity — the headline rule", () => {
  const base = { gUsd: 100, sGUsdValue: 20, spotValue: 30 };

  it("a verified flat contributes zero", () => {
    const out = portfolioEquity({ ...base, perpRows: [] });
    expect(out).toEqual({ total: 150, perpEquity: 0, perpCountsTowardTotal: true });
  });

  it("fully-marked rows add their equity — including negative equity", () => {
    const rows = [
      { asset: "H100" as const, side: "long" as const, position: marked({ equity: 9 }) },
      { asset: "H200" as const, side: "short" as const, position: marked({ equity: -4 }) },
    ];
    const out = portfolioEquity({ ...base, perpRows: rows });
    expect(out).toEqual({ total: 155, perpEquity: 5, perpCountsTowardTotal: true });
  });

  it("live-but-unmarked rows omit perps and say so — never a silent zero", () => {
    const rows = [
      { asset: "H100" as const, side: "long" as const, position: marked({ equity: 9 }) },
      { asset: "H200" as const, side: "short" as const, position: unmarked({}) },
    ];
    const out = portfolioEquity({ ...base, perpRows: rows });
    expect(out.total).toBe(150); // base only — the omission is deliberate
    expect(out.perpEquity).toBeNull();
    expect(out.perpCountsTowardTotal).toBe(false);
  });
});