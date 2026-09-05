/**
 * The write path. One factory turns any wallet's EIP-1193 provider — Privy
 * embedded or an injected external — into a viem WalletClient. This is the
 * normalization point: nothing downstream learns where the provider came
 * from. Signing and writes only; reads go through ./public-client.
 */

import { createWalletClient, custom, UserRejectedRequestError, type Hex, type WalletClient } from "viem";
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

/**
 * Normalize a wallet's message signature to the standard 65-byte form.
 *
 * Some wallets answer personal_sign with the EIP-2098 compact form — 64
 * bytes, `r || vs`, the recovery parity folded into vs's high bit. Recovery
 * libraries accept it; Privy's server does not ("Invalid SIWE message
 * and/or signature"). Expand compact back to `r || s || v` and lift a
 * yParity-style v (0/1) to the conventional 27/28 while here.
 */
export function normalizeSignature(signature: string): Hex {
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) return signature as Hex;
  // EIP-2098: 64 bytes = 128 hex chars = 130 with the 0x prefix.
  if (signature.length === 130) {
    const r = signature.slice(2, 66);
    const vs = signature.slice(66, 130);
    const vsFirst = parseInt(vs.slice(0, 2), 16);
    const yParity = (vsFirst & 0x80) >> 7;
    const sFirst = vsFirst & 0x7f;
    return `0x${r}${sFirst.toString(16).padStart(2, "0")}${vs.slice(2)}${(27 + yParity).toString(16)}` as Hex;
  }
  // 65 bytes = 130 hex chars = 132 with the 0x prefix; v ∈ {0,1} lifts to 27/28.
  if (signature.length === 132) {
    const v = parseInt(signature.slice(130), 16);
    if (v <= 1) return `0x${signature.slice(2, 130)}${(27 + v).toString(16)}` as Hex;
  }
  return signature as Hex;
}
