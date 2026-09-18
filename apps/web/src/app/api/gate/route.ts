/**
 * POST /api/gate — check the access phrase, mark the browser through-the-door.
 * Plain form POST friendly: HTML requests get redirects (the no-JS path),
 * JSON requests get JSON. Sets an httpOnly cookie (value is a fixed token,
 * never the phrase itself) for 30 days.
 */

import { NextResponse } from "next/server";
import {
  GATE_COOKIE,
  GATE_PASSWORD,
  GATE_PATH,
  GATE_TOKEN,
  gateCookieOptions,
  gateNextParam,
  safeGateNext,
} from "@/server/gate";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // No parseable body — treat as an empty submission.
    form = new FormData();
  }

  const phrase = String(form.get("password") ?? "");
  const next = safeGateNext(form.get("next"));
  const accept = request.headers.get("accept") ?? "";
  const wantsJson = accept.includes("application/json") && !accept.includes("text/html");

  const isHttps =
    new URL(request.url).protocol === "https:" ||
    (request.headers.get("x-forwarded-proto") ?? "").includes("https");

  if (phrase === GATE_PASSWORD) {
    const response = wantsJson
      ? NextResponse.json({ ok: true, next }, { status: 200 })
      : NextResponse.redirect(new URL(next, request.url), 303);
    response.cookies.set(GATE_COOKIE, GATE_TOKEN, gateCookieOptions(isHttps));
    return response;
  }

  const deniedUrl = new URL(`${GATE_PATH}${gateNextParam(next)}`, request.url);
  deniedUrl.searchParams.set("e", "1");
  return wantsJson
    ? NextResponse.json({ ok: false }, { status: 401 })
    : NextResponse.redirect(deniedUrl, 303);
}
