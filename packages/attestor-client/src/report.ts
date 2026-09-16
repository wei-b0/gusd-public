import {
  encodeAbiParameters,
  keccak256,
  type TypedDataDomain,
} from "viem";

/**
 * The oracle's fixed-point scale: 1 USD/GPU-hour = 10_000 units. Coordination-
 * fixed with apps/contracts/src/GPUIssuance.sol's PRICE_SCALE — changing one
 * without the other breaks every trade.
 */
export const PRICE_SCALE = 10_000n;

/** Default epoch length (seconds) — mirrors GpuOracle's constructor default. */
export const EPOCH_LENGTH_DEFAULT = 60;

/** Default observation floor (seconds) — mirrors GpuOracle's default; must stay >= epochLength. */
export const MAX_OBSERVATION_AGE_DEFAULT = 300;

/** EIP-712 domain values — must match GpuOracle's `EIP712("gUSD GPU Oracle", "1")`. */
export const GPU_ORACLE_DOMAIN_NAME = "gUSD GPU Oracle";
export const GPU_ORACLE_DOMAIN_VERSION = "1";

/**
 * The signed report (schema V1). Field order is load-bearing: it must match
 * GpuOracle's `_REPORT_TYPEHASH` exactly —
 * `Report(uint16 version,bytes32 gpuId,uint256 price,uint64 observedAt,uint64 epoch,uint64 validFrom,uint64 validUntil,bytes32 calcHash)`.
 */
export interface ReportV1 {
  version: 1;
  /** Canonical SKU the price applies to (bytes32 left-aligned ASCII). */
  gpuId: `0x${string}`;
  /** USD/GPU-hour x PRICE_SCALE as a positive bigint. */
  price: bigint;
  /** Engine computation time, unix seconds; <= now at consumption. */
  observedAt: number;
  /** Validity epoch: must equal floor(unix_sec / epochLength) at consumption. */
  epoch: number;
  /** epoch * epochLength (inclusive). */
  validFrom: number;
  /** validFrom + epochLength (exclusive). */
  validUntil: number;
  /** Methodology/receipt hash binding this report to a reproducible engine run. */
  calcHash: `0x${string}`;
}

/** A report plus its 65-byte (r, s, v) EIP-712 signature. */
export interface SignedReport {
  report: ReportV1;
  /** 65-byte signature, `0x`-prefixed (viem's serialized form). */
  signature: `0x${string}`;
}

/** EIP-712 type definition consumed by viem's signTypedData/verifyTypedData. */
export const REPORT_TYPE = {
  Report: [
    { name: "version", type: "uint16" },
    { name: "gpuId", type: "bytes32" },
    { name: "price", type: "uint256" },
    { name: "observedAt", type: "uint64" },
    { name: "epoch", type: "uint64" },
    { name: "validFrom", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "calcHash", type: "bytes32" },
  ],
} as const;

/** The domain the GpuOracle hashes over (chain + contract bound, so cross-chain replay is rejected). */
export interface GpuOracleDomain {
  chainId: number;
  verifyingContract: `0x${string}`;
}

export function domainSeparatorInputs(d: GpuOracleDomain): TypedDataDomain {
  return {
    name: GPU_ORACLE_DOMAIN_NAME,
    version: GPU_ORACLE_DOMAIN_VERSION,
    chainId: d.chainId,
    verifyingContract: d.verifyingContract,
  };
}

/** Max deviation from the exact scaled value tolerated as float noise. */
const SCALE_EPSILON = 1e-6;

/**
 * Encodes a SKU string into the canonical bytes32 GPU ID.
 *
 * Encoded byte-by-byte via charCodeAt rather than `Buffer.from(sku, "ascii")`,
 * which silently masks the high bit and would accept non-ASCII input the
 * contract's GpuId.validate rejects.
 */
export function encodeGpuId(sku: string): `0x${string}` {
  if (sku.length < 1 || sku.length > 32) {
    throw new Error(`gpuId must be 1-32 bytes, got ${sku.length}: "${sku}"`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < sku.length; i++) {
    const code = sku.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) {
      throw new Error(
        `gpuId byte at ${i} is not printable ASCII (0x21..0x7E): 0x${code.toString(16)}`,
      );
    }
    bytes[i] = code;
  }
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex as `0x${string}`;
}

/** Inverse of encodeGpuId — trims the zero padding and returns the SKU string. */
export function decodeGpuId(id: `0x${string}`): string {
  const raw = id.slice(2);
  let out = "";
  for (let i = 0; i < 64; i += 2) {
    const code = Number.parseInt(raw.slice(i, i + 2), 16);
    if (code === 0) break; // zero padding starts
    if (code < 0x21 || code > 0x7e) {
      throw new Error(`gpuId byte at ${i / 2} is not printable ASCII: 0x${code.toString(16)}`);
    }
    out += String.fromCharCode(code);
  }
  if (out.length < 1) throw new Error("gpuId is empty");
  return out;
}

/**
 * Scales a USD-per-GPU-hour price into the oracle's 4-decimal fixed point.
 *
 * Throws unless the price is positive and lands within float noise of an
 * integer after scaling — a value like 2.50015 (5 decimals) is a caller bug
 * and must stop the attestation, not round silently.
 */
export function priceToScaled(price: number): bigint {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`price must be a positive finite number, got ${price}`);
  }
  const exact = price * Number(PRICE_SCALE);
  const scaled = BigInt(Math.round(exact));
  if (scaled === 0n) {
    throw new Error(`price ${price} scales to 0 (below ${1 / Number(PRICE_SCALE)})`);
  }
  if (Math.abs(exact - Number(scaled)) > SCALE_EPSILON) {
    throw new Error(
      `price ${price} is not a 4-decimal value (scales to ${exact}, expected an integer)`,
    );
  }
  return scaled;
}

/** Inverse of priceToScaled — the display form of a scaled report price. */
export function scaledToPrice(scaled: bigint): number {
  return Number(scaled) / Number(PRICE_SCALE);
}

/**
 * Converts an observation timestamp to unix seconds, clamped to `now` — the
 * GpuOracle rejects future `observedAt` (FutureObservation), so an attestor
 * clock that has drifted ahead must not ship a future timestamp.
 */
export function observationSeconds(computedAtMs: number, nowMs: number = Date.now()): number {
  if (!Number.isFinite(computedAtMs)) {
    throw new Error(`computedAtMs is not a finite number: "${computedAtMs}"`);
  }
  return Math.floor(Math.min(computedAtMs, nowMs) / 1000);
}

/** The deterministic epoch arithmetic the whole oracle shares: floor(sec / epochLength). */
export function epochOf(unixSec: number, epochLength: number = EPOCH_LENGTH_DEFAULT): number {
  if (!Number.isInteger(epochLength) || epochLength <= 0) {
    throw new Error(`epochLength must be a positive integer, got ${epochLength}`);
  }
  if (!Number.isInteger(unixSec) || unixSec < 0) {
    throw new Error(`unixSec must be a non-negative integer, got ${unixSec}`);
  }
  return Math.floor(unixSec / epochLength);
}

/**
 * Builds a report for the epoch that contains `nowSec` — the epoch being
 * attested INTO (NOT observedAt's epoch: a healthy candidate observed late in
 * epoch E is re-attested into E+1 within the observation floor). Throws when
 * the observation is older than maxObservationAge — there is nothing honest
 * to attest.
 */
export function buildReport(params: {
  gpuId: string;
  /** USD/GPU-hour (4-decimal); scaled internally. */
  price: number;
  /** Engine computation time, unix seconds (clamped to nowSec). */
  observedAtSec: number;
  /** The wall clock the report is attested under, unix seconds. */
  nowSec: number;
  epochLength?: number;
  maxObservationAge?: number;
  calcHash: `0x${string}`;
}): ReportV1 {
  const epochLength = params.epochLength ?? EPOCH_LENGTH_DEFAULT;
  const maxAge = params.maxObservationAge ?? MAX_OBSERVATION_AGE_DEFAULT;
  if (maxAge < epochLength) {
    throw new Error(
      `maxObservationAge (${maxAge}) must be >= epochLength (${epochLength}) — the contract enforces ObservationAgeBelowEpoch`,
    );
  }
  const age = params.nowSec - params.observedAtSec;
  if (age > maxAge) {
    throw new Error(
      `observation is stale: observedAt ${params.observedAtSec} is ${age}s old (floor ${maxAge}s) — nothing to attest`,
    );
  }
  const observedAt = observationSeconds(params.observedAtSec * 1000, params.nowSec * 1000);
  const epoch = epochOf(params.nowSec, epochLength);
  const validFrom = epoch * epochLength;
  return {
    version: 1,
    gpuId: encodeGpuId(params.gpuId),
    price: priceToScaled(params.price),
    observedAt,
    epoch,
    validFrom,
    validUntil: validFrom + epochLength,
    calcHash: params.calcHash,
  };
}

const TUPLE = REPORT_TYPE.Report.map((f) => ({ type: f.type }));

/**
 * The trade-embedded payload: `abi.encode(report, signature)` — byte-identical
 * to what GpuOracle.reportHash and every consumer decode. Byte-identical
 * updateData re-consumes idempotently within an epoch (the dedupe key).
 */
export function encodeUpdateData(signed: SignedReport): `0x${string}` {
  const r = signed.report;
  return encodeAbiParameters(
    [{ type: "tuple", components: TUPLE }, { type: "bytes" }],
    [
      [
        r.version,
        r.gpuId,
        r.price,
        r.observedAt,
        r.epoch,
        r.validFrom,
        r.validUntil,
        r.calcHash,
      ],
      signed.signature,
    ],
  );
}

/** keccak256(abi.encode(report, signature)) — the epoch-binding identity. */
export function reportHash(signed: SignedReport): `0x${string}` {
  return keccak256(encodeUpdateData(signed));
}

/**
 * The viem typed-data bundle whose digest is exactly what the attestor signs
 * and GpuOracle.reportDigest recovers (signTypedData_v4).
 */
export function reportTypedData(r: ReportV1, domain: GpuOracleDomain) {
  return {
    domain: domainSeparatorInputs(domain),
    types: REPORT_TYPE,
    primaryType: "Report" as const,
    message: {
      version: r.version,
      gpuId: r.gpuId,
      price: r.price,
      observedAt: r.observedAt,
      epoch: r.epoch,
      validFrom: r.validFrom,
      validUntil: r.validUntil,
      calcHash: r.calcHash,
    },
  };
}
