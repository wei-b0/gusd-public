import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev-tools badge photobombs review rasters; the terminal ships clean.
  devIndicators: false,
  // Earn and Vaults folded into the gUSD section; Index and Data folded into
  // the Oracle section; the market detail page folded into the Terminal —
  // one roof for asset depth and execution. Old routes follow. `/terminal`
  // has no unbound form: the mode link lands on the default desk (H100), so
  // every desk owns its URL.
  redirects: async () => [
    { source: "/earn", destination: "/gusd", permanent: true },
    { source: "/vaults", destination: "/gusd", permanent: true },
    { source: "/index", destination: "/oracle", permanent: true },
    { source: "/index/:asset", destination: "/oracle/:asset", permanent: true },
    { source: "/data", destination: "/oracle", permanent: true },
    { source: "/markets/:asset", destination: "/terminal/:asset", permanent: true },
    { source: "/terminal", destination: "/terminal/H100", permanent: true },
  ],
};

export default nextConfig;
