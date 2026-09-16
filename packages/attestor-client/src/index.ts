/**
 * The shared pull-oracle report codec — the single TypeScript source of the
 * `Report` wire format for the attestor (signing), the oracle API (serving)
 * and the web (embedding updateData in trade calls).
 *
 * Encoding contract (mirrors apps/contracts/src/oracle/IGpuOracle.sol):
 *  - `Report` is an EIP-712 struct over domain
 *    {name: "gUSD GPU Oracle", version: "1", chainId, verifyingContract}.
 *  - `updateData = abi.encode(report, signature)` — what trade callers embed
 *    in BuyParams/SellParams (the SAME transaction that consumes the price).
 *  - `reportHash = keccak256(updateData)` — the epoch-binding identity the
 *    GpuOracle dedupes on.
 *  - `price` is USD/GPU-hour x PRICE_SCALE (10_000) — 4-decimal fixed point.
 *  - `gpuId` is bytes32 holding a left-aligned, zero-padded printable-ASCII
 *    SKU (bijective with packages/gpu-catalog string ids).
 *  - `epoch` is the epoch being attested INTO: floor(unix_sec / EPOCH_LENGTH);
 *    `validFrom = epoch * EPOCH_LENGTH`, `validUntil = validFrom + EPOCH_LENGTH`.
 */
export {
  PRICE_SCALE,
  EPOCH_LENGTH_DEFAULT,
  MAX_OBSERVATION_AGE_DEFAULT,
  REPORT_TYPE,
  GPU_ORACLE_DOMAIN_NAME,
  GPU_ORACLE_DOMAIN_VERSION,
  type GpuOracleDomain,
  type ReportV1,
  type SignedReport,
  domainSeparatorInputs,
  encodeGpuId,
  decodeGpuId,
  priceToScaled,
  scaledToPrice,
  observationSeconds,
  epochOf,
  buildReport,
  encodeUpdateData,
  reportHash,
  reportTypedData,
} from "./report.js";
export { signReport, signReportRaw, type SignerLike } from "./sign.js";
