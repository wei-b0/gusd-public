import { NextResponse, type NextRequest } from "next/server";
import { GATE_API_PATH, GATE_COOKIE, GATE_PATH, GATE_TOKEN, gateNextParam } from "@/server/gate";

/**
 * Site-wide entry gate — currently DISABLED. The gate code is preserved for
 * future re-enable: the phrase/cookie truth lives in src/server/gate.ts, the
 * door page at src/app/gate/page.tsx, and POST /api/gate still sets the
 * cookie. Flip GATE_ENABLED to true to turn the door back on.
 *
 * When enabled:
 *  - Every route sits behind the access phrase until the browser carries the
 *    gate cookie (httpOnly, 30 days, set by POST /api/gate — see
 *    src/app/gate/page.tsx). Hardcoded per brief: a light door for preview
 *    deployments, not access control.
 *  - Unauthenticated page requests rewrite to /gate, keeping the URL so the
 *    phrase lands the visitor where they were headed (?next=).
 *  - Unauthenticated API requests get a plain 401 JSON — fetch never follows
 *    the door.
 *  - /gate and /api/gate stay open; a browser already through the door
 *    hitting /gate is sent to the front desk.
 *  - Static assets (_next/static, _next/image, favicon) skip the proxy
 *    entirely — the pages that reference them are gated, so hashed asset
 *    URLs are useless without one.
 */
const GATE_ENABLED: boolean = false;

/** The gate's enforcement, kept verbatim for the next time the door closes. */
function gate(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const authed = request.cookies.get(GATE_COOKIE)?.value === GATE_TOKEN;

  if (authed) {
    if (pathname === GATE_PATH) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  if (pathname === GATE_PATH || pathname === GATE_API_PATH) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = GATE_PATH;
  url.search = gateNextParam(pathname + search);
  return NextResponse.rewrite(url);
}

export function proxy(request: NextRequest) {
  if (GATE_ENABLED) {
    return gate(request);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
