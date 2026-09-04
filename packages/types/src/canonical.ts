/**
 * Deterministic canonical serialization.
 *
 * The pricing engine and the audit trail need byte-stable JSON: sorted keys
 * (code-unit order, identical across machines), stable number formatting
 * (ECMAScript Number::toString shortest round-trip, spec-deterministic), and
 * arrays preserved in order. `calcHash` is SHA-256 over this output, and
 * deterministic replay byte-compares it.
 */

const MAX_SAFE_DEPTH = 64;

export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_SAFE_DEPTH) {
    throw new Error("canonicalJson: maximum depth exceeded");
  }
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "bigint") throw new Error("canonicalJson: bigint is not canonicalizable");
  if (value === undefined || (typeof value === "object" && Number.isNaN(value))) {
    throw new Error("canonicalJson: undefined/NaN is not canonicalizable");
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    const items = value.map((v) => canonicalJson(v, depth + 1));
    return `[${items.join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k], depth + 1)}`);
  return `{${pairs.join(",")}}`;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error("canonicalJson: non-finite number is not canonicalizable");
  }
  // -0 must not produce "-0"; canonicalize to "0".
  if (Object.is(n, -0)) return "0";
  return JSON.stringify(n);
}

/**
 * Round to 4 decimal places. All prices pass through this before entering
 * receipts or the database so float artifacts cannot make byte-identical
 * computations serialize differently.
 */
export function round4(x: number): number {
  if (!Number.isFinite(x)) {
    throw new Error(`round4: non-finite input ${x}`);
  }
  return Math.round(x * 10_000) / 10_000;
}

/**
 * SHA-256 hex digest over a canonical string. Uses WebCrypto (available in
 * Node ≥ 15 and browsers); returns lowercase hex.
 */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
