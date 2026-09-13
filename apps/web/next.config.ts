import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev-tools badge photobombs review rasters; the terminal ships clean.
  devIndicators: false,
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
