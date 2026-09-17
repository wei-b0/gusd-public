import { describe, expect, it } from "vitest";
import { buildReport, encodeUpdateData, reportTypedData, signReport, type SignerLike } from "../src/index.js";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";

const DOMAIN = { chainId: 31337, verifyingContract: "0x0000000000000000000000000000000000010cc0" as const };
// fixed test key — fixtures are reproducible; NEVER an operational key
const ATTESTOR_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ATTESTOR = privateKeyToAccount(ATTESTOR_PK);
// viem's account satisfies SignerLike at runtime; the parameter type is
// structurally narrower than the interface — the same bridge apps/attestor's
// reportSigner makes (the attestor never signs anything but reports).
const signer: SignerLike = {
  signTypedData: (args) => ATTESTOR.signTypedData(args as never),
};

function report() {
  return buildReport({
    gpuId: "H100_SXM_80GB",
    price: 2.5,
    observedAtSec: 1_000_000,
    nowSec: 1_000_005,
    calcHash: "0xc0dec0dec0dec0dec0dec0dec0dec0dec0dec0dec0dec0dec0dec0dec0dec0de",
  });
}

describe("signReport", () => {
  it("produces a 65-byte signature the domain recovers to the attestor", async () => {
    const r = report();
    const signed = await signReport(signer, r, DOMAIN);
    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
    const bundle = reportTypedData(r, DOMAIN);
    const ok = await verifyTypedData({
      domain: bundle.domain,
      types: bundle.types,
      primaryType: bundle.primaryType,
      message: bundle.message,
      signature: signed.signature,
      address: ATTESTOR.address,
    });
    expect(ok).toBe(true);
  });

  it("binds the signature to the domain: a different chain or contract fails verification", async () => {
    const r = report();
    const signed = await signReport(signer, r, DOMAIN);
    for (const domain of [
      { chainId: 1, verifyingContract: DOMAIN.verifyingContract },
      { chainId: 31337, verifyingContract: "0x0000000000000000000000000000000000000001" as const },
    ]) {
      const bundle = reportTypedData(r, domain);
      const ok = await verifyTypedData({
        domain: bundle.domain,
        types: bundle.types,
        primaryType: bundle.primaryType,
        message: bundle.message,
        signature: signed.signature,
        address: ATTESTOR.address,
      });
      expect(ok).toBe(false);
    }
  });

  it("is deterministic over identical report bytes", async () => {
    const a = await signReport(signer, report(), DOMAIN);
    const b = await signReport(signer, report(), DOMAIN);
    expect(encodeUpdateData(a)).toBe(encodeUpdateData(b));
  });
});
