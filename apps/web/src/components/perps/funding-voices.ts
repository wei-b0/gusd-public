/**
 * The funding voice — the one place ppm/second rates become trader words.
 * Every surface (rail, strip, board, statistics, close preview) speaks
 * funding through these helpers so the sign's meaning never splits:
 * positive ppm means that side PAYS the other, and the words always say
 * which. `num` lives here too as the shared plain-number formatter.
 */

import { fmtPctAdaptive, fmtSignedGusd } from "@/domain/format";

/** Plain number, max 2dp, trailing zeros trimmed: 20 / 2.5 / 0.21. */
export function num(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/\.?0+$/, "");
}

/** Funding ppm/second → the per-day figure the desk speaks. */
export function perDay(ppm: number): string {
  return fmtPctAdaptive((ppm * 86_400) / 10_000);
}

/** A position's net funding in cash-flow words — net > 0 is debt the
 *  position pays; net < 0 it receives. Never a bare sign. */
export function fundingCashVoice(net: number): string {
  if (net === 0) return "0.0000 gUSD";
  return net < 0
    ? `${fmtSignedGusd(-net)} gUSD received`
    : `${fmtSignedGusd(-net)} gUSD paid`;
}

/** One side's funding rate in cash-flow words — positive means that side
 *  PAYS the other, so the sign always carries its meaning: "pays 0.212%" /
 *  "receives 0.212%" / "flat". */
export function fundingVoice(ppm: number): string {
  if (ppm === 0) return "flat";
  return `${ppm > 0 ? "pays" : "receives"} ${perDay(Math.abs(ppm))}`;
}

/** The rail's compact funding voice: "0.212% pay" / "0.212% rec" / "0%". */
export function fundingShort(ppm: number): string {
  if (ppm === 0) return "0%";
  return `${perDay(Math.abs(ppm))} ${ppm > 0 ? "pay" : "rec"}`;
}