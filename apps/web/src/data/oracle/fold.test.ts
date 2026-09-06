import { describe, expect, it } from "vitest";
import { foldCandidateIntoBuckets } from "./fold";
import type { CandleDto } from "./dto";

/**
 * Grid-faithful fold semantics — the parity contract between the client's
 * realtime merges and the server's own /candles bucketing. Every case here
 * is a way a naive fold drifts from the server grid: carried promotion,
 * gap splicing, prepend discipline, window bounds, runaway fills.
 */

const bucket = (t: number, o: number, h: number, l: number, c: number, samples = 2): CandleDto => ({
  t,
  open: o,
  high: h,
  low: l,
  close: c,
  samples,
});
const carried = (t: number, c: number): CandleDto => ({
  t,
  open: c,
  high: c,
  low: c,
  close: c,
  samples: 0,
  carried: true,
});

describe("foldCandidateIntoBuckets", () => {
  it("folds a print into the trailing real bucket", () => {
    const buckets = [bucket(0, 10, 12, 9, 11)];
    const next = foldCandidateIntoBuckets(buckets, { t: 100_000, price: 13 }, 300, 0);
    expect(next).not.toBeNull();
    expect(next![0]).toEqual({ t: 0, open: 10, high: 13, low: 9, close: 13, samples: 3 });
  });

  it("updates the low and the close on a downside print", () => {
    const buckets = [bucket(0, 10, 12, 9, 11)];
    const next = foldCandidateIntoBuckets(buckets, { t: 299_999, price: 8.5 }, 300, 0);
    expect(next![0]).toEqual({ t: 0, open: 10, high: 12, low: 8.5, close: 8.5, samples: 3 });
  });

  it("promotes a carried bucket with the print as its open", () => {
    const buckets = [bucket(0, 10, 12, 9, 11), carried(300_000, 11)];
    const next = foldCandidateIntoBuckets(buckets, { t: 310_000, price: 12.5 }, 300, 0);
    // The carried level is NOT the open — the interval's first real
    // computation is, and samples counts real prints only.
    expect(next![1]).toEqual({ t: 300_000, open: 12.5, high: 12.5, low: 12.5, close: 12.5, samples: 1 });
    expect(next![1]!.carried).toBeUndefined();
    expect(next![0]).toEqual(buckets[0]);
  });

  it("splices carried buckets before a new bucket beyond the last", () => {
    const buckets = [bucket(0, 10, 12, 9, 11)];
    // print lands 3 intervals ahead → two silent steps in between
    const next = foldCandidateIntoBuckets(buckets, { t: 901_000, price: 12 }, 300, 0);
    expect(next!.map((b) => b.t)).toEqual([0, 300_000, 600_000, 900_000]);
    expect(next![1]).toEqual(carried(300_000, 11));
    expect(next![2]).toEqual(carried(600_000, 11));
    expect(next![3]).toEqual({ t: 900_000, open: 12, high: 12, low: 12, close: 12, samples: 1 });
  });

  it("carries from the close before the gap, not the new print", () => {
    const buckets = [bucket(0, 10, 12, 9, 11)];
    const next = foldCandidateIntoBuckets(buckets, { t: 901_000, price: 30 }, 300, 0);
    expect(next![1]!.close).toBe(11);
    expect(next![2]!.close).toBe(11);
    expect(next![3]!.open).toBe(30);
  });

  it("refuses a pathological gap instead of synthesizing history", () => {
    const buckets = [bucket(0, 10, 12, 9, 11)];
    // 2002 steps ahead — the fill would exceed the server's own bucket cap.
    const next = foldCandidateIntoBuckets(buckets, { t: 2002 * 60_000 + 1, price: 12 }, 60, 0);
    expect(next).toBeNull();
  });

  it("ignores a print before the loaded window", () => {
    const buckets = [bucket(600_000, 10, 12, 9, 11)];
    const next = foldCandidateIntoBuckets(buckets, { t: 100_000, price: 9 }, 300, 600_000);
    expect(next).toBeNull();
  });

  it("prepends a single real bucket before the first observation", () => {
    const buckets = [bucket(600_000, 10, 12, 9, 11)];
    const next = foldCandidateIntoBuckets(buckets, { t: 100_000, price: 9 }, 300, 0);
    // No carried history before the first observation — server semantics.
    expect(next!.map((b) => b.t)).toEqual([0, 600_000]);
    expect(next![0]).toEqual({ t: 0, open: 9, high: 9, low: 9, close: 9, samples: 1 });
    expect(next![0]!.carried).toBeUndefined();
  });

  it("keeps the grid ascending and regular on every supported interval", () => {
    for (const intervalSec of [60, 300, 900, 1800, 3600, 21600, 43200, 86400, 604800]) {
      const stepMs = intervalSec * 1000;
      const buckets = [bucket(0, 10, 12, 9, 11)];
      const next = foldCandidateIntoBuckets(buckets, { t: stepMs * 3 + 1, price: 12 }, intervalSec, 0);
      const ts = next!.map((b) => b.t);
      expect(ts, `interval ${intervalSec}`).toEqual([0, stepMs, stepMs * 2, stepMs * 3]);
      for (let i = 1; i < ts.length; i++) {
        expect(ts[i]! - ts[i - 1]!, `interval ${intervalSec} step ${i}`).toBe(stepMs);
      }
    }
  });

  it("never mutates the input buckets", () => {
    const buckets = [bucket(0, 10, 12, 9, 11), carried(300_000, 11)];
    const snapshot = buckets.map((b) => ({ ...b }));
    foldCandidateIntoBuckets(buckets, { t: 310_000, price: 12.5 }, 300, 0);
    expect(buckets).toEqual(snapshot);
  });
});
