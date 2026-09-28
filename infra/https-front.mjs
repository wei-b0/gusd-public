/**
 * https-front.mjs — the LAN HTTPS entry for the local dev stack.
 *
 * Privy refuses embedded wallets outside a secure context (plain http on a
 * LAN IP throws "Embedded wallet is only available over HTTPS"), and once a
 * page is https, browsers block plain-http fetches (mixed content). One TLS
 * front in front of all three services solves both: the browser sees a
 * single https origin and every upstream hop stays on host loopback.
 *
 *   https://<LAN>:3443/rpc/*    → anvil        (127.0.0.1:8545)
 *   https://<LAN>:3443/v1/*     → oracle API   (127.0.0.1:8080 — also serves
 *                                                 the /v1/protocol indexer
 *                                                 surface and the SSE stream)
 *   everything else             → web dev      (127.0.0.1:3000)
 *
 * The cert is self-signed (infra/dev-cert.pem): open the origin once in each
 * browser and accept the warning — the origin is then a secure context and
 * Privy boots. Point NEXT_PUBLIC_ORACLE_URL / NEXT_PUBLIC_INDEXER_URL /
 * NEXT_PUBLIC_RPC_URL_31337 at this origin (see apps/web/.env.local notes).
 *
 * Run: node infra/https-front.mjs   (HOST/PORT/TLS cert paths overridable)
 * Zero dependencies — node built-ins only; streams are piped raw, so the
 * oracle's SSE stream passes through unbuffered.
 */

import { createServer as createHttps } from "node:https";
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.HTTPS_FRONT_PORT ?? 3443);
const HOST = process.env.HOST ?? "0.0.0.0";
const UP_WEB = process.env.UP_WEB ?? "http://127.0.0.1:3000";
const UP_ORACLE = process.env.UP_ORACLE ?? "http://127.0.0.1:8080";
const UP_ANVIL = process.env.UP_ANVIL ?? "http://127.0.0.1:8545";
const CERT = process.env.TLS_CERT ?? fileURLToPath(new URL("./dev-cert.pem", import.meta.url));
const KEY = process.env.TLS_KEY ?? fileURLToPath(new URL("./dev-cert-key.pem", import.meta.url));

/**
 * Route by path prefix: anvil's JSON-RPC lives at "/" (the /rpc prefix is
 * this front's routing only — strip it), the oracle serves /v1/* verbatim,
 * everything else is the web dev server. Query strings ride along everywhere.
 */
function route(url) {
  const [pathname, search = ""] = url.split("?");
  const q = search ? `?${search}` : "";
  if (pathname === "/rpc" || pathname.startsWith("/rpc/")) {
    return { base: UP_ANVIL, path: "/" + pathname.replace(/^\/rpc\/?/, "") + q };
  }
  if (pathname === "/v1" || pathname.startsWith("/v1/")) {
    return { base: UP_ORACLE, path: url };
  }
  return { base: UP_WEB, path: url };
}

/** Pipe a client request to an http upstream and stream the answer back. */
function proxy(clientReq, clientRes) {
  const { base, path } = route(clientReq.url);
  const upstream = new URL(base);
  const options = {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
    method: clientReq.method,
    path,
    headers: { ...clientReq.headers, host: `${upstream.hostname}:${upstream.port}` },
  };
  const upReq = httpRequest(options, (upRes) => {
    clientRes.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(clientRes); // streams — SSE/chunked pass through unbuffered
  });
  upReq.on("error", (err) => {
    if (!clientRes.headersSent) clientRes.writeHead(502, { "content-type": "text/plain" });
    clientRes.end(`https-front: upstream ${options.hostname}:${options.port} unreachable — ${err.message}`);
  });
  clientReq.pipe(upReq);
  clientReq.on("error", () => upReq.destroy());
  clientRes.on("close", () => upReq.destroy());
}

const server = createHttps({ cert: readFileSync(CERT), key: readFileSync(KEY) }, proxy);
server.listen(PORT, HOST, () => {
  console.log(`[https-front] https://0.0.0.0:${PORT}  (web→${UP_WEB}, /v1→${UP_ORACLE}, /rpc→${UP_ANVIL})`);
});
