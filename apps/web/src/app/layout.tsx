import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

/**
 * JetBrains Mono, self-hosted and complete. The full files cover the geometric
 * shapes the terminal grammar draws with (▲ ▼ ▶ ▸ ● ○ ≠ →) that the Google
 * latin subset's unicode-range excludes — under the subset, those glyphs fell
 * through to a size-adjusted Arial fallback face and rendered in the wrong
 * typeface mid-run. `adjustFontFallback: false` so no proportional fallback
 * face is generated again; anything uncovered degrades to ui-monospace.
 */
const jbMono = localFont({
  src: [
    { path: "../../public/fonts/jetbrains-mono/JetBrainsMono-Regular.woff2", weight: "400", style: "normal" },
    { path: "../../public/fonts/jetbrains-mono/JetBrainsMono-Medium.woff2", weight: "500", style: "normal" },
    { path: "../../public/fonts/jetbrains-mono/JetBrainsMono-Bold.woff2", weight: "700", style: "normal" },
    { path: "../../public/fonts/jetbrains-mono/JetBrainsMono-ExtraBold.woff2", weight: "800", style: "normal" },
  ],
  display: "swap",
  variable: "--font-jb",
  adjustFontFallback: false,
});

export const metadata: Metadata = {
  title: "gUSD — The GPU Assets Protocol",
  description:
    "The GPU Assets Protocol: a market for GPU assets quoted in gUSD, the protocol's settlement unit. Trade GPU markets at a premium or discount to the gUSD Index benchmarks.",
};

/**
 * Bare root: html, glass, type. The machine shell (system bar, function-key
 * rail, status line) belongs to the product surfaces and lives in the
 * (shell) group; the entry gate renders without it — nothing on the door
 * may call a resource the lock itself guards.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={jbMono.variable}>
      <body>{children}</body>
    </html>
  );
}
