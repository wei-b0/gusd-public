import { describe, expect, it } from "vitest";
import {
  EPOCH_LENGTH_DEFAULT,
  MAX_OBSERVATION_AGE_DEFAULT,
  PRICE_SCALE,
  REPORT_TYPE,
  buildReport,
  decodeGpuId,
  domainSeparatorInputs,
  encodeGpuId,
  encodeUpdateData,
  epochOf,
  observationSeconds,
  priceToScaled,
  reportHash,
  reportTypedData,
  scaledToPrice,
} from "../src/index.js";
import { concat, encodeAbiParameters, hashTypedData, keccak256, toBytes, toHex } from "viem";

const DOMAIN = { chainId: 31337, verifyingContract: "0x0000000000000000000000000000000000010cc0" as const };

function report(overrides: Partial<Parameters<typeof buildReport>[0]> = {}) {
  return buildReport({
    gpuId: "H100_SXM_80GB",
    price: 2.5,
    observedAtSec: 1_000_000,
    nowSec: 1_000_005,
    calcHash: "0xc0dec0dec0dec0dec0dec0dec0dec0dec0dec0dec0dec0dec0dec0dec0dec0de",
    ...overrides,
  });
}

describe("gpu id codec", () => {
  it("encodes left-aligned, zero-padded printable ASCII", () => {
    expect(encodeGpuId("H100_SXM_80GB")).toBe(
      "0x483130305f53584d5f3830474200000000000000000000000000000000000000",
    );
  });

  it("round-trips", () => {
    expect(decodeGpuId(encodeGpuId("H200_141GB"))).toBe("H200_141GB");
    expect(decodeGpuId(encodeGpuId("A"))).toBe("A");
  });

  it("rejects non-printable, empty and oversized SKUs", () => {
    expect(() => encodeGpuId("")).toThrow();
    expect(() => encodeGpuId("x".repeat(33))).toThrow();
    expect(() => encodeGpuId("a b")).toThrow(); // 0x20 space is below 0x21
    expect(() => encodeGpuId("é")).toThrow();
    expect(() =>
      decodeGpuId("0x0000000000000000000000000000000000000000000000000000000000000000"),
    ).toThrow();
  });
});

describe("price scaling", () => {
  it("scales the worked example", () => {
    expect(priceToScaled(2.5)).toBe(25_000n);
    expect(priceToScaled(2.5001)).toBe(25_001n); // float noise, not a snap
    expect(priceToScaled(0.0001)).toBe(1n);
    expect(scaledToPrice(25_000n)).toBe(2.5);
  });

  it("refuses non-4-decimal, zero and negative prices", () => {
    expect(() => priceToScaled(2.50015)).toThrow();
    expect(() => priceToScaled(0)).toThrow();
    expect(() => priceToScaled(-1)).toThrow();
    expect(() => priceToScaled(Number.NaN)).toThrow();
  });

  it("keeps the coordination-fixed scale", () => {
    expect(PRICE_SCALE).toBe(10_000n);
  });
});

describe("epoch arithmetic", () => {
  it("matches the contract's currentEpoch definition", () => {
    expect(epochOf(0)).toBe(0);
    expect(epochOf(59)).toBe(0);
    expect(epochOf(60)).toBe(1);
    expect(epochOf(1_000_000)).toBe(16_666);
  });

  it("rejects non-integer or zero epoch lengths", () => {
    expect(() => epochOf(10, 0)).toThrow();
    expect(() => epochOf(10, 1.5)).toThrow();
  });
});

describe("observation clamping", () => {
  it("clamps a future observation to now", () => {
    expect(observationSeconds(2_000_000_000, 1_000_000_000)).toBe(1_000_000_000);
    expect(observationSeconds(999_999_999, 1_000_000_000)).toBe(999_999);
  });

  it("rejects non-finite input", () => {
    expect(() => observationSeconds(Number.NaN)).toThrow();
  });
});

describe("buildReport", () => {
  it("binds the report to the epoch containing now, not observedAt's epoch", () => {
    // observed late in epoch E (t=1_000_059), attested just past the boundary
    // into E+1: the report must carry epoch E+1 with bounds [1_000_060, 1_000_120)
    const r = report({ observedAtSec: 1_000_059, nowSec: 1_000_060 });
    expect(r.epoch).toBe(16_668); // floor(1_000_060 / 60)
    expect(r.validFrom).toBe(16_668 * 60);
    expect(r.validUntil).toBe(16_669 * 60);
    expect(r.observedAt).toBe(1_000_059);
  });

  it("defaults to the shipped epoch/observation constants", () => {
    const r = report();
    expect(r.epoch).toBe(epochOf(1_000_005, EPOCH_LENGTH_DEFAULT));
    // a build at maxAge exactly passes; older throws
    expect(() =>
      report({ observedAtSec: 1_000_005 - MAX_OBSERVATION_AGE_DEFAULT, nowSec: 1_000_005 }),
    ).not.toThrow();
    expect(() =>
      report({ observedAtSec: 1_000_004 - MAX_OBSERVATION_AGE_DEFAULT, nowSec: 1_000_005 }),
    ).toThrow(/stale/);
  });

  it("refuses a floor below the epoch length (contract invariant)", () => {
    expect(() => report({ nowSec: 1_000_005, epochLength: 120, maxObservationAge: 60 })).toThrow(
      />= epochLength/,
    );
  });

  it("carries version 1 and the given calcHash", () => {
    const r = report();
    expect(r.version).toBe(1);
    expect(r.calcHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("updateData encoding", () => {
  const SIG =
    "0x1111111111111111111111111111111111111111111111111111111111111111222222222222222222222222222222222222222222222222222222222222222233" as const;

  it("abi-encodes (report, signature) — the exact trade-embedded bytes", () => {
    const updateData = encodeUpdateData({ report: report(), signature: SIG });
    // layout: 8 tuple words + offset word + length word + 65B signature + pad
    expect(updateData.length).toBe(2 + 10 * 64 + 130);
    // price 25_000 sits in word 2 of the tuple
    expect(updateData.slice(2 + 2 * 64, 2 + 3 * 64)).toBe("61a8");
    expect(reportHash({ report: report(), signature: SIG })).toBe(keccak256(updateData));
  });

  it("is byte-stable across reserialization (the idempotency premise)", () => {
    const a = encodeUpdateData({ report: report(), signature: SIG });
    const b = encodeUpdateData({ report: { ...report() }, signature: SIG });
    expect(a).toBe(b);
  });
});

describe("EIP-712 digest", () => {
  // The exact typehash strings fixed in GpuOracle — a literal drift here
  // breaks every signature silently, so they are asserted, not assumed.
  const REPORT_TYPEHASH_STRING =
    "Report(uint16 version,bytes32 gpuId,uint256 price,uint64 observedAt,uint64 epoch,uint64 validFrom,uint64 validUntil,bytes32 calcHash)";
  const DOMAIN_TYPEHASH_STRING =
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

  it("uses the GpuOracle's exact field order", () => {
    expect(REPORT_TYPE.Report.map((f) => `${f.type} ${f.name}`).join(",")).toBe(
      "uint16 version,bytes32 gpuId,uint256 price,uint64 observedAt,uint64 epoch,uint64 validFrom,uint64 validUntil,bytes32 calcHash",
    );
    expect(reportTypedData(report(), DOMAIN).primaryType).toBe("Report");
  });

  it("assembles the canonical EIP-712 digest (same bytes GpuOracle._hashTypedDataV4 hashes)", () => {
    const r = report();
    const domain = domainSeparatorInputs(DOMAIN);

    // manual construction per the EIP-712 spec
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "address" },
        ],
        [
          keccak256(toHex(DOMAIN_TYPEHASH_STRING)),
          keccak256(toHex("gUSD GPU Oracle")),
          keccak256(toHex("1")),
          BigInt(DOMAIN.chainId),
          DOMAIN.verifyingContract,
        ],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, ...REPORT_TYPE.Report.map((f) => ({ type: f.type as "bytes32" }))],
        [
          keccak256(toHex(REPORT_TYPEHASH_STRING)),
          r.version,
          r.gpuId,
          r.price,
          r.observedAt,
          r.epoch,
          r.validFrom,
          r.validUntil,
          r.calcHash,
        ],
      ),
    );
    const manual = keccak256(concat(["0x1901", domainSeparator, structHash]));

    // viem's digest over our typed-data assembly must match byte-for-byte —
    // this is what the attestor signs and GpuOracle recovers
    const bundle = reportTypedData(r, DOMAIN);
    const viaViem = hashTypedData({
      domain: bundle.domain,
      types: bundle.types,
      primaryType: bundle.primaryType,
      message: bundle.message,
    });
    expect(viaViem).toBe(manual);
  });
});
