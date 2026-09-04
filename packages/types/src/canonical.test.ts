import { describe, expect, it } from "vitest";
import { canonicalJson, round4 } from "./canonical.js";

describe("canonicalJson", () => {
  it("sorts keys in code-unit order", () => {
    expect(canonicalJson({ b: 1, a: 2, A: 3 })).toBe('{"A":3,"a":2,"b":1}');
  });

  it("sorts recursively", () => {
    expect(canonicalJson({ z: { y: 1, x: [ { d: 1, c: 2 } ] } })).toBe(
      '{"z":{"x":[{"c":2,"d":1}],"y":1}}',
    );
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("serializes -0 as 0", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson({ x: -0 })).toBe('{"x":0}');
  });

  it("throws on NaN, Infinity, undefined, bigint", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: 1n })).toThrow();
  });

  it("is byte-stable across key insertion orders", () => {
    const a = canonicalJson({ gpu: "H100", price: 2.5, tier: "on_demand" });
    const b = canonicalJson({ tier: "on_demand", price: 2.5, gpu: "H100" });
    expect(a).toBe(b);
  });

  it("handles Date via ISO string", () => {
    expect(canonicalJson(new Date("2026-01-01T00:00:00.000Z"))).toBe('"2026-01-01T00:00:00.000Z"');
  });
});

describe("round4", () => {
  it("rounds to 4 decimals", () => {
    expect(round4(2.000015)).toBe(2.0000);
    expect(round4(1 / 3)).toBe(0.3333);
    expect(round4(2.00005)).toBe(2.0001);
  });

  it("throws on non-finite", () => {
    expect(() => round4(Number.NaN)).toThrow();
    expect(() => round4(Infinity)).toThrow();
  });
});
