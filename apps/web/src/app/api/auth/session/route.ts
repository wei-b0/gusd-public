/**
 * POST /api/auth/session — the identity boundary's write half.
 *
 * Verifies the caller's Privy tokens, resolves the one wallet from the
 * verified identity (never the body), and upserts it into `user_wallets`.
 * The unique index on address is what makes 1 user = 1 wallet true at rest:
 * a wallet re-authenticating maps back to its row; a new wallet is a new
 * gUSD account.
 */

import { upsertUserWallet } from "@gusd/db";
import { UnauthorizedError, WalletUnresolvedError } from "@/server/privy-verify";
import { requireSession } from "@/server/session";
import { getDb } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireSession(request);
    const row = await upsertUserWallet(getDb().db, {
      privyUserId: session.did,
      address: session.address,
      walletKind: session.walletKind,
      label: session.label,
    });
    return Response.json({
      did: row.privyUserId,
      address: row.address,
      walletKind: row.walletKind,
      label: row.label,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (err instanceof WalletUnresolvedError) {
      return Response.json({ error: "Wallet not provisioned yet" }, { status: 422 });
    }
    return Response.json({ error: "Session sync failed" }, { status: 500 });
  }
}
