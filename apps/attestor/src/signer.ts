import type { SignerLike } from "@gusd/attestor-client";
import { privateKeyToAccount } from "viem/accounts";

/**
 * viem's account satisfies the codec's SignerLike at runtime; the argument
 * type is narrower than the interface's structural shape, so bridge it
 * explicitly — the attestor never signs anything but reports.
 */
export function reportSigner(account: ReturnType<typeof privateKeyToAccount>): SignerLike {
  return {
    signTypedData: (args) =>
      account.signTypedData(args as unknown as Parameters<typeof account.signTypedData>[0]),
  };
}
