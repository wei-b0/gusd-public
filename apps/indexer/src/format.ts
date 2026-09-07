/**
 * gpuId encoding: left-aligned ASCII in a bytes32 ("H100_SXM_80GB" followed
 * by zero bytes). Pure, deterministic decoding — the chain never carries a
 * separate sku field, and catalog metadata is joined at the API, never here.
 */
export function decodeGpuId(gpuId: string): string {
  const hex = gpuId.startsWith("0x") ? gpuId.slice(2) : gpuId;
  const chars: string[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const byte = Number.parseInt(hex.slice(i, i + 2), 16);
    if (byte === 0) break;
    chars.push(String.fromCharCode(byte));
  }
  return chars.join("");
}
