/**
 * Attestation transport — the signed report a trade must carry. The pull
 * oracle has no on-chain publication to read: the desk fetches the CURRENT
 * epoch's attestation from the oracle API and embeds its `updateData` bytes
 * in the very transaction that consumes the price.
 *
 * Transport only, like the REST client beside it: GET, no custom headers,
 * one timeout. The status codes are DATA, not failures — 404 (never attested)
 * and 503 (attestor behind / corrupt row) both classify into non-executable
 * results so quoting and execution can speak one vocabulary about why.
 */

import {
  encodeGpuId,
  encodeUpdateData,
  reportHash,
  reportTypedData,
  type ReportV1,
  type SignedReport,
} from "@gusd/attestor-client";
import { FETCH_TIMEOUT_MS, ORACLE_BASE_URL } from "./config";

/** The attestation route's wire shape (apps/oracle server.ts). */
export interface AttestationDto {
  version: number;
  sku: string;
  gpuId: `0x${string}`;
  /** Scaled price as a decimal string (uint-safe). */
  price: string;
  observedAt: number;
  epoch: number;
  validFrom: number;
  validUntil: number;
  calcHash: `0x${string}`;
  signature: `0x${string}`;
  reportHash: `0x${string}`;
  updateData: `0x${string}`;
}

/** The parsed attestation, or why there isn't one. Every non-current kind is
 *  a fact about the attestor, never a transient to hide behind: a trade
 *  cannot execute without a current report, so the caller surfaces the kind. */
export type Attestation =
  | {
      kind: "current";
      /** The verified wire bytes — embed EXACTLY these in the trade call. */
      signed: SignedReport;
      updateData: `0x${string}`;
      reportHash: `0x${string}`;
    }
  /** 404: this gpu was never attested at all. */
  | { kind: "unknown-gpu" }
  /** 503: attestor missed the current epoch, its clock is skewed, or the
   *  stored row failed its re-encode check. */
  | { kind: "degraded" }
  /** Transport failed entirely (network/timeout/other http). */
  | { kind: "unreachable" };

/**
 * Parse + fail-closed re-verify: the served bytes must re-encode to the
 * reportHash the ledger recorded and decode back to the sku they claim.
 * Anything else classifies degraded — an unverifiable payload must never
 * ride into a trade.
 */
export function parseAttestation(dto: AttestationDto): Attestation {
  if (dto.version !== 1 || dto.price === "" || !/^0x/.test(dto.updateData)) {
    return { kind: "degraded" };
  }
  const report: ReportV1 = {
    version: 1,
    gpuId: dto.gpuId,
    price: BigInt(dto.price),
    observedAt: dto.observedAt,
    epoch: dto.epoch,
    validFrom: dto.validFrom,
    validUntil: dto.validUntil,
    calcHash: dto.calcHash,
  };
  let signed: SignedReport;
  try {
    signed = { report, signature: dto.signature };
    const updateData = encodeUpdateData(signed);
    if (updateData !== dto.updateData || reportHash(signed) !== dto.reportHash) {
      return { kind: "degraded" };
    }
  } catch {
    return { kind: "degraded" };
  }
  return { kind: "current", signed, updateData: dto.updateData, reportHash: dto.reportHash };
}

/**
 * Fetch the current-epoch attestation for a gpu (panel id or sku). Never
 * throws — every outcome classifies into Attestation; callers convert the
 * kind into their own failure voice.
 */
export async function fetchAttestation(
  gpuParam: string,
  baseUrl: string = ORACLE_BASE_URL,
): Promise<Attestation> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/prices/${encodeURIComponent(gpuParam)}/attestation`, {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return { kind: "unreachable" };
  }
  if (res.status === 404) return { kind: "unknown-gpu" };
  if (res.status === 503) return { kind: "degraded" };
  if (!res.ok) return { kind: "unreachable" };
  const dto = (await res.json()) as AttestationDto;
  const parsed = parseAttestation(dto);
  if (parsed.kind === "current") {
    // Identity check the route cannot do for us: the report must be for the
    // sku that was asked for (encodeGpuId throws on non-ASCII, so guard it).
    try {
      if (encodeGpuId(dto.sku) !== parsed.signed.report.gpuId) return { kind: "degraded" };
    } catch {
      return { kind: "degraded" };
    }
  }
  return parsed;
}

/** Convenience for display surfaces: the current attestation's price in the
 *  scaled unit, or null. */
export function attestedPrice(a: Attestation): bigint | null {
  return a.kind === "current" ? a.signed.report.price : null;
}

/** The typed-data bundle the report's signature verifies against — exposed
 *  for the slip's provenance display and tests. */
export function attestationTypedData(signed: SignedReport, domain: { chainId: number; verifyingContract: `0x${string}` }) {
  return reportTypedData(signed.report, domain);
}
