import type { SignedReport, GpuOracleDomain, ReportV1 } from "./report.js";
import { reportTypedData } from "./report.js";

/** Anything that can produce an EIP-712 signature over typed data (viem accounts). */
export interface SignerLike {
  signTypedData(args: {
    domain: unknown;
    types: unknown;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

/**
 * Signs a report with the attestor key. The attestor NEVER broadcasts: the
 * signature is served over the API and embedded by trade callers.
 */
export async function signReport(
  signer: SignerLike,
  report: ReportV1,
  domain: GpuOracleDomain,
): Promise<SignedReport> {
  return { report, signature: await signReportRaw(signer, report, domain) };
}

/** Signs and returns only the 65-byte signature (r, s, v). */
export async function signReportRaw(
  signer: SignerLike,
  report: ReportV1,
  domain: GpuOracleDomain,
): Promise<`0x${string}`> {
  return signer.signTypedData(reportTypedData(report, domain));
}
