import { NextResponse, type NextRequest } from "next/server";
import { GATE_API_PATH, GATE_COOKIE, GATE_PATH, GATE_TOKEN, gateNextParam } from "@/server/gate";

/**
 * Site-wide entry gate. Every route sits behind the access phrase until the
 * browser carries the gate cookie (httpOnly, 30 days, set by POST /api/gate —
 * see src/app/gate/page.tsx). Hardcoded per brief: a light door for preview
 * deployments, not access control.
 *
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
export function proxy(request: NextRequest) {
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

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
