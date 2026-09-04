/**
 * The wire encoding between the publisher and the onchain GPUPriceOracle —
 * the TypeScript mirror of the contract fixed in IGPUPriceOracle's NatSpec:
 *
 *  - `gpuId`: bytes32 holding a left-aligned, zero-padded printable-ASCII SKU
 *    (0x21..0x7E, 1-32 bytes) — bijective with `packages/gpu-catalog` string
 *    IDs and with `apps/contracts/src/libraries/GpuId.sol`.
 *  - `price`: USD per GPU-hour x PRICE_SCALE (10_000), i.e. 4-decimal fixed
 *    point. JS numbers are floats, so the scaling rounds and then round-trip
 *    checks the result — `2.5001 * 10_000 === 25000.999999999996` must land
 *    as 25001, and a price that is not a 4-decimal value must be refused,
 *    never silently snapped.
 *  - `updatedAt`: unix seconds of the observation, clamped to now (the chain
 *    rejects future timestamps).
 */

/** The oracle's fixed-point scale: 1 USD/GPU-hour = 10_000 units. */
export const PRICE_SCALE = 10_000n;

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

/**
 * Scales a USD-per-GPU-hour price into the oracle's 4-decimal fixed point.
 *
 * Throws unless the price is positive and lands within float noise of an
 * integer after scaling — a value like 2.50015 (5 decimals) is a caller bug
 * and must stop the publish, not round silently.
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

/**
 * Converts an ISO observation timestamp to unix seconds, clamped to `now` —
 * the oracle clamps future `updatedAt` on write and consumers reject it, so a
 * publisher clock that has drifted ahead must not ship a future timestamp.
 */
export function updatedAtSeconds(computedAtIso: string, nowMs: number = Date.now()): number {
  const t = Date.parse(computedAtIso);
  if (Number.isNaN(t)) {
    throw new Error(`computedAt is not a valid ISO timestamp: "${computedAtIso}"`);
  }
  return Math.floor(Math.min(t, nowMs) / 1000);
}
