/**
 * Dev-only tick demonstrator. `?demo=ticks` serves the mock universe's own
 * 1.8 s market-data tick so flash telemetry can be seen on demand, side by
 * side with a live tab. False on the server (no window) and inlined to a
 * compile-time false in production builds — dead code, a no-op, outside dev.
 */
export const DEMO_TICKS =
  process.env.NODE_ENV !== "production" &&
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("demo") === "ticks";

/**
 * Dev-only cross-chain demonstrator: `?demo=fund` opens the Get gUSD desk
 * with a bridge origin preselected, so the remote route — unreachable on a
 * dev network without a mainnet wallet — can be walked on demand. Same
 * compile-out contract as DEMO_TICKS.
 */
export const DEMO_FUND =
  process.env.NODE_ENV !== "production" &&
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("demo") === "fund";
