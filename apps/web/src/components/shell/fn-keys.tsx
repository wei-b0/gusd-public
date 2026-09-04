"use client";

/**
 * FnKeys — the navigation rail, split by audience. Four function keys carry
 * the user's operating modes — Markets, Terminal, gUSD, Portfolio — each
 * with the full product name, the active route reversed amber. Oracle — the
 * pricing/benchmark/data infrastructure the modes run on — sits apart at the
 * rail's far end, behind a rule, in wire cyan with no F-key: accessible
 * system reference, not a fifth operating mode. Protocol is intentionally
 * absent (it lives behind the Oracle access panel and the command line).
 * Click routes; the command line accepts the same names. The rail never
 * hides.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Gusd } from "@/components/ui/pair";

const KEYS = [
  { f: "F1", name: "Markets", href: "/markets" },
  { f: "F2", name: "Terminal", href: "/terminal" },
  { f: "F3", name: "gUSD", href: "/gusd" },
  { f: "F4", name: "Portfolio", href: "/portfolio" },
] as const;

export function FnKeys() {
  const pathname = usePathname();
  const oracleActive = pathname === "/oracle" || pathname.startsWith("/oracle/");
  return (
    <nav
      aria-label="Primary navigation"
      className="sticky top-12 z-30 border-b border-rule-strong bg-panel"
    >
      <div className="mx-auto flex w-full max-w-360 items-stretch overflow-x-auto px-3 md:px-5">
        {KEYS.map((k) => {
          const active =
            pathname === k.href ||
            pathname.startsWith(`${k.href}/`) ||
            (k.href === "/markets" && pathname === "/");
          return (
            <Link
              key={k.name}
              href={k.href}
              aria-current={active ? "page" : undefined}
              className={`slug flex shrink-0 items-center gap-1.5 px-3 py-1.5 transition-colors ${
                active ? "rev" : "text-dim hover:bg-panel-deep hover:text-data"
              }`}
            >
              <span aria-hidden className={active ? "text-rev-fg" : "text-dim opacity-70"}>
                {k.f}
              </span>
              {k.name === "gUSD" ? <Gusd /> : k.name}
            </Link>
          );
        })}
        {/* System reference rides the far end — separated, wire cyan, keyless. */}
        <span aria-hidden className="h-px min-w-4 flex-1" />
        <Link
          href="/oracle"
          aria-current={oracleActive ? "page" : undefined}
          className={`slug flex shrink-0 items-center border-l border-rule-strong py-1.5 pl-3 pr-1 transition-colors ${
            oracleActive ? "rev-w" : "text-wire hover:bg-panel-deep hover:text-bright"
          }`}
        >
          Oracle
        </Link>
      </div>
    </nav>
  );
}
