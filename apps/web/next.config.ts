import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev-tools badge photobombs review rasters; the terminal ships clean.
  devIndicators: false,
  // Earn and Vaults folded into the gUSD section; Index and Data folded into
  // the Oracle section. Old routes follow.
  redirects: async () => [
    { source: "/earn", destination: "/gusd", permanent: true },
    { source: "/vaults", destination: "/gusd", permanent: true },
    { source: "/index", destination: "/oracle", permanent: true },
    { source: "/index/:asset", destination: "/oracle/:asset", permanent: true },
    { source: "/data", destination: "/oracle", permanent: true },
  ],
};

export default nextConfig;
