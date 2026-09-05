import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import { normalizeSignature } from "./wallet-client";

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const MESSAGE = "localhost:3000 wants you to sign in with your Ethereum account";

/** Encode a standard 65-byte signature as EIP-2098 (r || vs). */
function toEip2098(signature: `0x${string}`): `0x${string}` {
  const r = signature.slice(2, 66);
  const s = signature.slice(66, 130);
  const v = parseInt(signature.slice(130), 16);
  const vsFirst = parseInt(s.slice(0, 2), 16) | ((v - 27) << 7);
  return `0x${r}${vsFirst.toString(16).padStart(2, "0")}${s.slice(2)}`;
}

describe("normalizeSignature", () => {
  it("leaves a standard 65-byte signature untouched", async () => {
    const sig = await account.signMessage({ message: MESSAGE });
    expect(sig.length).toBe(132);
    expect(normalizeSignature(sig)).toBe(sig);
  });

  it("expands EIP-2098 compact signatures to 65 bytes", async () => {
    const sig = await account.signMessage({ message: MESSAGE });
    const compact = toEip2098(sig);
    expect(compact.length).toBe(130);
    const expanded = normalizeSignature(compact);
    expect(expanded.length).toBe(132);
    expect(expanded).toBe(sig);
    // Both forms recover to the same signer.
    const fromStandard = await recoverMessageAddress({ message: MESSAGE, signature: sig });
    const fromExpanded = await recoverMessageAddress({
      message: MESSAGE,
      signature: expanded,
    });
    expect(fromExpanded.toLowerCase()).toBe(fromStandard.toLowerCase());
  });

  it("lifts a yParity-style v (0/1) to the conventional 27/28", async () => {
    const sig = await account.signMessage({ message: MESSAGE });
    const v = parseInt(sig.slice(130), 16);
    const parityForm = `0x${sig.slice(2, 130)}${(v - 27).toString(16).padStart(2, "0")}` as `0x${string}`;
    expect(normalizeSignature(parityForm)).toBe(sig);
  });

  it("passes through non-hex garbage untouched", () => {
    expect(normalizeSignature("not-a-signature")).toBe("not-a-signature");
  });
});
