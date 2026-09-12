import { describe, expect, it } from "vitest";
import { encodeGpuId, priceToScaled, updatedAtSeconds } from "../src/encoding.js";

describe("encodeGpuId", () => {
  // the launch settlement panels in packages/gpu-catalog
  it("encodes the catalog SKUs to their canonical left-aligned bytes32", () => {
    expect(encodeGpuId("H100_SXM_80GB")).toBe(
      "0x483130305f53584d5f3830474200000000000000000000000000000000000000",
    );
    expect(encodeGpuId("H200_141GB")).toBe(
      "0x483230305f313431474200000000000000000000000000000000000000000000",
    );
    expect(encodeGpuId("L40S_48GB")).toBe(
      "0x4c3430535f343847420000000000000000000000000000000000000000000000",
    );
    expect(encodeGpuId("RTX_4090_24GB")).toBe(
      "0x5254585f343039305f3234474200000000000000000000000000000000000000",
    );
  });

  it("is bijective with Solidity bytes32(bytes(sku)) for a single byte and 32 bytes", () => {
    // single printable char: left-aligned, 31 zero bytes
    expect(encodeGpuId("A")).toBe(
      "0x4100000000000000000000000000000000000000000000000000000000000000",
    );
    // a full 32-byte ID is valid without padding (GpuId.sol: no terminator needed)
    const full = "ABCDEFGH01_IJKLMNOP02_QRSTUVWX03";
    expect(full.length).toBe(32);
    expect(encodeGpuId(full).length).toBe(66); // 0x + 64 hex chars
  });

  it("refuses empty, oversized, and non-printable SKUs", () => {
    expect(() => encodeGpuId("")).toThrow(/1-32 bytes/);
    expect(() => encodeGpuId("A".repeat(33))).toThrow(/1-32 bytes/);
    // space is 0x20 — below the 0x21 floor, same rejection as GpuId.sol
    expect(() => encodeGpuId("H100 SXM")).toThrow(/not printable ASCII.*0x20/);
    // DEL (0x7f) is above the 0x7E ceiling
    expect(() => encodeGpuId("H100\x7f")).toThrow(/not printable ASCII.*0x7f/);
    // Buffer 'ascii' would mask the high bit; charCodeAt must not
    expect(() => encodeGpuId("H100é")).toThrow(/not printable ASCII.*0xe9/);
    // an embedded control char
    expect(() => encodeGpuId("H1\x0000")).toThrow(/not printable ASCII.*0x0/);
  });
});

describe("priceToScaled", () => {
  it("scales exact 4-decimal prices to integers", () => {
    expect(priceToScaled(2.5)).toBe(25_000n);
    expect(priceToScaled(2.94)).toBe(29_400n);
    expect(priceToScaled(0.0001)).toBe(1n);
    expect(priceToScaled(9999.9999)).toBe(99_999_999n);
  });

  it("lands 2.5001 on 25001 despite the float noise in the scaling", () => {
    expect(2.5001 * 10_000).toBe(25001.000000000004); // the trap, pinned
    expect(priceToScaled(2.5001)).toBe(25_001n);
  });

  it("refuses non-positive, non-finite, and sub-scale prices", () => {
    expect(() => priceToScaled(0)).toThrow(/positive finite/);
    expect(() => priceToScaled(-1)).toThrow(/positive finite/);
    expect(() => priceToScaled(Number.NaN)).toThrow(/positive finite/);
    expect(() => priceToScaled(Number.POSITIVE_INFINITY)).toThrow(/positive finite/);
    // 1e-9 rounds to 0 — the contract's InvalidPrice must never be reachable
    expect(() => priceToScaled(1e-9)).toThrow(/scales to 0/);
  });

  it("refuses prices that are not 4-decimal values", () => {
    expect(() => priceToScaled(2.50015)).toThrow(/not a 4-decimal value/);
    expect(() => priceToScaled(2.5001499)).toThrow(/not a 4-decimal value/);
  });
});

describe("updatedAtSeconds", () => {
  const NOW = Date.parse("2026-09-04T12:00:00.500Z");

  it("floors the observation to unix seconds", () => {
    expect(updatedAtSeconds("2026-09-04T11:59:50.000Z", NOW)).toBe(
      Date.parse("2026-09-04T11:59:50.000Z") / 1000,
    );
  });

  it("clamps a publisher-clock timestamp that has drifted ahead of now", () => {
    expect(updatedAtSeconds("2026-09-04T12:00:05.000Z", NOW)).toBe(
      Math.floor(NOW / 1000),
    );
  });

  it("refuses an invalid ISO timestamp", () => {
    expect(() => updatedAtSeconds("not-a-date", NOW)).toThrow(/not a valid ISO timestamp/);
  });
});
