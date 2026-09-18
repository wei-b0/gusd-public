/**
 * The entry gate's shared server truth: the phrase, the cookie that proves
 * it was spoken, and the redirect-target validator. Hardcoded per brief —
 * a light door for preview deployments, not access control. Importable from
 * the edge proxy and node route handlers alike (no node APIs here).
 */

export const GATE_PATH = "/gate";
export const GATE_API_PATH = "/api/gate";

/** The phrase the gate asks for. */
export const GATE_PASSWORD = "HackThisIfYouCan";

/** Cookie that marks a browser as through-the-door (not the phrase itself). */
export const GATE_COOKIE = "gusd_gate";
export const GATE_TOKEN = "9b141a7ffa36443162b5389fc9f6e322";

export const GATE_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function gateCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: GATE_COOKIE_MAX_AGE,
    secure,
  };
}

/**
 * Only same-origin relative paths may follow the door. Returns "/" for
 * anything absent, protocol-relative, backslash-tricked, or scheme-carrying.
 */
export function safeGateNext(raw: FormDataEntryValue | string | null | undefined): string {
  const value = typeof raw === "string" ? raw : "";
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return "/";
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.startsWith("/\\")) {
    return "/";
  }
  return decoded;
}

/** The ?next= value carried through proxy rewrites and failed attempts. */
export function gateNextParam(path: string): string {
  if (!path || path === "/") return "";
  return `?next=${encodeURIComponent(path)}`;
}
