/**
 * GET /api/me — address-keyed server-side identity lookup. Verifies the
 * caller, then reads `user_wallets` by the verified address. 404 when the
 * wallet has never synced (the caller should POST /api/auth/session first).
 */

import { findUserWalletByAddress } from "@gusd/db";
import { UnauthorizedError, WalletUnresolvedError } from "@/server/privy-verify";
import { requireSession } from "@/server/session";
import { getDb } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await requireSession(request);
    const row = await findUserWalletByAddress(getDb().db, session.address);
    if (!row) {
      return Response.json({ error: "Wallet not registered" }, { status: 404 });
    }
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
    return Response.json({ error: "Identity lookup failed" }, { status: 500 });
  }
}
