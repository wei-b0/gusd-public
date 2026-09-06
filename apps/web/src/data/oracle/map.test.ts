import { describe, expect, it } from "vitest";
import { mapIndexTelemetry } from "./map";
import type { CandidateDto } from "./dto";

/**
 * Telemetry mapping — the wire-faithful contract: every field is the latest
 * candidate's own, the per-hour count is real landings only (deduped by
 * publication hash, bounded by the trailing hour), and an empty series maps
 * to all-null rather than zeros posed as live wire facts.
 */

const HOUR_MS = 3_600_000;

const candidate = (overrides: Partial<CandidateDto>): CandidateDto => ({
  gpuId: "H100",
  panelId: "h100-pcie-80gb",
  price: 3.14,
  confidenceLow: 3.1,
  confidenceHigh: 3.2,
  dispersion: 0.018,
  status: "healthy",
  providersObserved: 8,
  providersContributing: 6,
  methodologyVersion: "1",
  calcHash: "a".repeat(64),
  computedAt: new Date(0).toISOString(),
  windowStart: new Date(-1_800_000).toISOString(),
  windowEnd: new Date(0).toISOString(),
  ...overrides,
});

/** A series landing every 15s ending at `now` (oldest-first), with `dup` of
 *  the newest candidate repeated verbatim — a re-delivered landing. */
const series = (now: number, n: number, dup = 0): CandidateDto[] => {
  const rows: CandidateDto[] = [];
  for (let i = n - 1; i >= 0; i--) {
    rows.push(
      candidate({
        calcHash: `hash-${i}`,
        computedAt: new Date(now - i * 15_000).toISOString(),
      }),
    );
  }
  if (dup > 0) rows.push(...rows.slice(-dup).map((r) => ({ ...r })));
  return rows;
};

describe("mapIndexTelemetry", () => {
  it("maps an empty series to all-null — never zeros posed as live", () => {
    expect(mapIndexTelemetry([], 0)).toEqual({
      dispersion: null,
      confidenceLow: null,
      confidenceHigh: null,
      sourcesObserved: null,
      sourcesContributing: null,
      publications1h: null,
      lastPublishedAt: null,
    });
  });

  it("surfaces the latest panel's own wire fields", () => {
    const now = 1_000_000_000;
    const telemetry = mapIndexTelemetry(series(now, 4), now);
    expect(telemetry.dispersion).toBe(0.018);
    expect(telemetry.confidenceLow).toBe(3.1);
    expect(telemetry.confidenceHigh).toBe(3.2);
    expect(telemetry.sourcesObserved).toBe(8);
    expect(telemetry.sourcesContributing).toBe(6);
    expect(telemetry.lastPublishedAt).toBe(now);
  });

  it("counts distinct publications in the trailing hour, deduped by hash", () => {
    const now = 1_000_000_000;
    // 4 landings at 15s spacing, newest re-delivered verbatim: still 4.
    const telemetry = mapIndexTelemetry(series(now, 4, 1), now);
    expect(telemetry.publications1h).toBe(4);
  });

  it("excludes landings older than the trailing hour", () => {
    const now = 1_000_000_000;
    const rows = [
      candidate({ calcHash: "old", computedAt: new Date(now - HOUR_MS - 15_000).toISOString() }),
      ...series(now, 3),
    ];
    expect(mapIndexTelemetry(rows, now).publications1h).toBe(3);
  });

  it("counts a withheld panel as a landed publication", () => {
    const now = 1_000_000_000;
    const rows = series(now, 2).map((r, i) =>
      i === 1 ? { ...r, status: "withheld", price: null } : r,
    );
    const telemetry = mapIndexTelemetry(rows, now);
    expect(telemetry.publications1h).toBe(2);
  });
});
