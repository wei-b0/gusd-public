/**
 * Request authentication for route handlers: headers in, a verified
 * identity out. The address comes exclusively from the verified identity
 * tokens — bodies, query params, and other headers are never identity
 * sources.
 */

import { fmtAddress } from "@/domain/format";
import type { WalletKind } from "@gusd/types";
import { resolveWallet, verifyPrivySession, WalletUnresolvedError } from "./privy-verify";

export interface AuthedSession {
  /** Privy user DID. */
  did: string;
  /** Privy session id. */
  sessionId: string;
  /** The session's one wallet address, lowercase hex. */
  address: string;
  walletKind: WalletKind;
  /** Address-derived display label (0x1234…abcd) — never personal data. */
  label: string;
}

/** Verify the request's tokens and resolve its wallet identity. */
export async function requireSession(request: Request): Promise<AuthedSession> {
  const authorization = request.headers.get("authorization");
  const accessToken = authorization?.replace(/^Bearer /i, "").trim() || null;
  const idToken = request.headers.get("x-privy-id-token")?.trim() || null;

  const { userId, sessionId, user } = await verifyPrivySession(accessToken, idToken);

  const wallet = resolveWallet(user);
  if (!wallet) {
    throw new WalletUnresolvedError("No wallet account on the session — embedded wallet still provisioning.");
  }

  return {
    did: userId,
    sessionId,
    address: wallet.address,
    walletKind: wallet.walletKind,
    label: fmtAddress(wallet.address),
  };
}
