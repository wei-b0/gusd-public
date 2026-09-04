/**
 * Presentation formatters for the domain vocabulary. All UI numerals flow
 * through here so precision and units stay consistent product-wide.
 */

const usd3 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});

const usd3Fixed = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

const signed = new Intl.NumberFormat("en-US", {
  signDisplay: "always",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const int = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const plain3 = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

const plain3Fixed = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

const plain4Fixed = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

/**
 * USD formatters — the benchmark's unit alone. The `$` prints only on Index
 * figures (USD per GPU-hour); the financial markets quote in gUSD and use
 * the plain formatters below.
 */

/** Benchmark/Index price readout: $2.514 */
export function fmtUsdPrecise(value: number): string {
  return usd3.format(value);
}

/** Chart-legend Index price, fixed at 3 decimals so one line never wobbles: $2.428 */
export function fmtUsdLegend(value: number): string {
  return usd3Fixed.format(value);
}

/**
 * gUSD formatters — the markets' unit. Plain numerals; the `gUSD` unit is
 * carried by the figure itself, a column head, or the surrounding label.
 */

/** Market price readout: 2.485 */
export function fmtGusdPrecise(value: number): string {
  return plain3.format(value);
}

/** Market price with its unit: 2.485 gUSD */
export function fmtGusd(value: number): string {
  return `${plain3.format(value)} gUSD`;
}

/** Chart-legend market price, fixed at 3 decimals: 2.485 */
export function fmtGusdLegend(value: number): string {
  return plain3Fixed.format(value);
}

/** Ledger-grade gUSD, fixed at 4 decimals so quoted rows visibly sum: 2.5147 */
export function fmtGusdLedger(value: number): string {
  return plain4Fixed.format(value);
}

/** gUSD amounts, compact for dense columns: 3.60M / 842.1K / 34.163 */
export function fmtGusdCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return plain3.format(value);
}

/** Index reference price: $2.428 / GPU-hour */
export function fmtPerHour(value: number): string {
  return `$${plain3.format(value)} / GPU-hour`;
}

/** Signed percent: +3.29% / −1.12%; rounds-to-zero prints unsigned 0.00% */
export function fmtPctSigned(value: number): string {
  if (Math.abs(value) < 0.005) return "0.00%";
  return `${signed.format(value)}%`;
}

/** True when a percent rounds to zero — callers give it a neutral tone. */
export function isFlatPct(value: number): boolean {
  return Math.abs(value) < 0.005;
}

/** Unsigned percent: 3.29 */
export function fmtPct(value: number): string {
  return `${value.toFixed(2)}%`;
}

/** Order-level gUSD amounts: compact once past 1K gUSD, instrument-grade below. */
export function fmtNotional(value: number): string {
  if (value >= 1_000) return fmtGusdCompact(value);
  return fmtGusdPrecise(value);
}

/** Unit sizes with scale-appropriate decimals: 6.400 / 12.25 / 140.0 */
export function fmtUnits(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
  return value.toFixed(digits);
}

/** gUSD notional, full with separators: 1,242,380 */
export function fmtFull(value: number): string {
  return int.format(Math.round(value));
}

/** Signed integer: +4 / −2 */
export function fmtSignedInt(value: number): string {
  return `${value > 0 ? "+" : ""}${int.format(value)}`;
}

/** Signed size: +4.20 / −1.0 */
export function fmtSize(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${abs.toFixed(digits)}`;
}

const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Edition dateline, print style: 4 September 2026 */
export function fmtEdition(t: number): string {
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS_FULL[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Instrument stamp: 04 SEP 2026 14:00 UTC */
export function fmtStamp(t: number): string {
  const d = new Date(t);
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** Clock stamp: 14:00:12 */
export function fmtClock(t: number): string {
  const d = new Date(t);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Chart axis stamp, pick by granularity. */
export function fmtAxisTime(t: number, range: "1D" | "1W" | "1M" | "3M"): string {
  const d = new Date(t);
  if (range === "1D") return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (range === "1W") return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:00`;
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}`;
}

/** Relative age for freshness stamps: 4s ago / 2m ago */
export function fmtAge(from: number, now: number): string {
  const s = Math.max(0, Math.round((now - from) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}
