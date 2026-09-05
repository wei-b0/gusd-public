import { describe, expect, it } from "vitest";
import { fmtAddress, fmtHash } from "./format";

describe("chain identifier formatting", () => {
  it("compacts addresses to head…tail", () => {
    expect(fmtAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe(
      "0x1234…5678",
    );
  });

  it("leaves short inputs alone", () => {
    expect(fmtAddress("0x1234")).toBe("0x1234");
  });

  it("compacts hashes with a longer head", () => {
    expect(fmtHash("0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef")).toBe(
      "0x123456…cdef",
    );
  });
});
