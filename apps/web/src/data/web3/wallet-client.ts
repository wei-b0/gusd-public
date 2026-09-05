/**
 * The write path. One factory turns any wallet's EIP-1193 provider — Privy
 * embedded or an injected external — into a viem WalletClient. This is the
 * normalization point: nothing downstream learns where the provider came
 * from. Signing and writes only; reads go through ./public-client.
 */

import { createWalletClient, custom, UserRejectedRequestError, type WalletClient } from "viem";
import type { EIP1193Provider } from "@privy-io/react-auth";
import { getActiveChain } from "./chains";

/**
 * Build a WalletClient over a wallet's own provider, bound to the active
 * chain. Callers pre-check the wallet's network (the auth port refuses
 * getWalletClient off-chain), so no chainId parameter — a client bound to a
 * different chain than the registry's would only disguise a wrong-network
 * write as a valid one.
 */
export function createWalletClientFromProvider(options: {
  address: string;
  provider: EIP1193Provider;
}): WalletClient {
  return createWalletClient({
    account: options.address as `0x${string}`,
    chain: getActiveChain(),
    transport: custom(options.provider),
  });
}

/**
 * True when an error is the user declining a signature or connection — the
 * one wallet error with its own product voice ("Signature declined."), never
 * rendered as a system failure. Covers the EIP-1193 4001 code, viem's typed
 * error, and the string fallbacks older providers emit.
 */
export function isUserRejection(err: unknown): boolean {
  if (err instanceof UserRejectedRequestError) return true;
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (code === 4001) return true;
  }
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /user rejected|user denied|rejected the request|declined/i.test(message);
}
