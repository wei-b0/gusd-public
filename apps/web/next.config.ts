import type { NextConfig } from "next";

/**
 * Same-origin dev proxy: when DEV_SAME_ORIGIN=1 (apps/web/.env.local, the
 * LAN-HTTPS posture), the dev server itself carries the whole client data
 * plane — /v1/* to the oracle API (which also serves the /v1/protocol
 * indexer surface and the SSE stream) and /rpc to anvil's JSON-RPC. Privy
 * needs a secure context for embedded wallets, and an https page cannot
 * fetch plain-http upstreams (mixed content) — proxying through the https
 * server solves both with one origin and no extra process. Server-side env
 * (not NEXT_PUBLIC_): the rewrite is dev-infra, never part of a build.
 */
const DEV_SAME_ORIGIN = process.env.DEV_SAME_ORIGIN === "1";
const UP_ORACLE = process.env.UP_ORACLE ?? "http://127.0.0.1:8080";
const UP_ANVIL = process.env.UP_ANVIL ?? "http://127.0.0.1:8545";

const nextConfig: NextConfig = {
  // The dev-tools badge photobombs review rasters; the terminal ships clean.
  devIndicators: false,
  // The stack is reviewed from phones on the LAN (192.168.0.103:3000); Next 16
  // blocks cross-origin dev requests unless the host is allow-listed here.
  allowedDevOrigins: ["192.168.0.103"],
  rewrites: DEV_SAME_ORIGIN
    ? async () => [
        // JSON-RPC lives at "/" on anvil — the /rpc prefix is this proxy's
        // routing only, stripped here. The oracle serves /v1/* verbatim.
        { source: "/rpc", destination: `${UP_ANVIL}/` },
        { source: "/rpc/:path*", destination: `${UP_ANVIL}/:path*` },
        { source: "/v1/:path*", destination: `${UP_ORACLE}/v1/:path*` },
        { source: "/v1", destination: `${UP_ORACLE}/v1` },
      ]
    : async () => [],
  // Earn and Vaults folded into the gUSD section; Index and Data folded into
  // the Oracle section's tabs; per-GPU oracle pages folded into the
  // Benchmarks tab's inline panel receipt; the market detail page folded
  // into the Terminal — one roof for asset depth and execution. /markets
  // folded into the front door: both rendered the same discovery surface,
  // so one URL carries it (banner, roadmap included). Old routes follow.
  // `/terminal` has no unbound form: the mode link lands on the
  // default desk (H100), so every desk owns its URL.
  redirects: async () => [
    { source: "/markets", destination: "/", permanent: true },
    { source: "/earn", destination: "/gusd", permanent: true },
    { source: "/vaults", destination: "/gusd", permanent: true },
    { source: "/oracle/:asset", destination: "/oracle?tab=benchmarks&bench=:asset", permanent: true },
    { source: "/index", destination: "/oracle?tab=benchmarks", permanent: true },
    { source: "/index/:asset", destination: "/oracle?tab=benchmarks&bench=:asset", permanent: true },
    { source: "/data", destination: "/oracle?tab=developers", permanent: true },
    { source: "/markets/:asset", destination: "/terminal/:asset", permanent: true },
    { source: "/terminal", destination: "/terminal/H100", permanent: true },
  ],
};

export default nextConfig;
