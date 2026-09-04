import { randomBytes } from "node:crypto";

/**
 * UUIDv7 generator: 48-bit big-endian Unix millisecond timestamp + version 7
 * + variant bits + 62 random bits. Lexicographic order ≈ time order, which
 * makes append-only tables cluster sensibly and gives runs a sortable id.
 *
 * NOTE: lives in a subpath export (`@gusd/types/ids`) and is deliberately NOT
 * re-exported from the package root, so pure packages (pricing-engine) never
 * pull node:crypto into their import graph.
 */
export function newId(): string {
  const bytes = randomBytes(16);
  const ts = Date.now();
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
