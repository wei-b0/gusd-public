"use client";

/**
 * SystemBar — the machine's top rule: wordmark, command line, connection
 * control, live UTC clock. Present on every route. The command line speaks
 * the product's own names — markets, terminal B200, oracle, gusd — and a
 * bare GPU asset routes to that market's page.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { parseAssetId } from "@/domain/types";
import { fmtClock, fmtFull } from "@/domain/format";
import { Gusd, SGusd } from "@/components/ui/pair";
import { useAccount, useServices } from "@/data/services";

/** Command word → route; null when the word is unknown. */
function resolveCommand(raw: string): string | null {
  const parts = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const head = parts[0];
  const arg = parts[1];
  if (!head) return null;
  const target = arg ? parseAssetId(arg) : null;
  if (arg && !target) return null;
  switch (head) {
    case "markets":
    case "board":
      return target ? `/markets/${target}` : "/markets";
    case "terminal":
      return target ? `/terminal/${target}` : "/terminal";
    case "oracle":
    case "index":
    case "data":
      return target ? `/oracle/${target}` : "/oracle";
    case "gusd":
    case "sgusd":
    case "mint":
    case "earn":
    case "vaults":
      return "/gusd";
    case "portfolio":
      return "/portfolio";
    case "protocol":
      return "/protocol";
    default:
      return parseAssetId(head) ? `/markets/${parseAssetId(head)}` : null;
  }
}

export function SystemBar() {
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A rejected command reports once, then the line clears itself.
  useEffect(() => {
    return () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    };
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const href = resolveCommand(raw);
    if (!href) {
      const code = raw.trim().toUpperCase();
      setError(
        `UNKNOWN COMMAND "${code}" — TRY MARKETS · TERMINAL · ORACLE`,
      );
      if (clearTimer.current) clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setError(null), 3_200);
      return;
    }
    setError(null);
    setRaw("");
    router.push(href);
  }

  return (
    <header className="sticky top-0 z-40 border-b border-rule-strong bg-panel">
      <div className="mx-auto flex h-12 w-full max-w-360 items-center gap-3 px-3 md:px-5">
        <Link href="/" className="flex shrink-0 items-baseline gap-2.5 outline-none">
          <span className="disp text-[19px] leading-none text-bright">gUSD</span>
          <span className="slug hidden text-dim md:inline">The GPU Assets Protocol</span>
        </Link>

        <form onSubmit={submit} className="ml-1 flex min-w-0 flex-1 items-center sm:ml-4">
          <span aria-hidden className="num text-[15px] font-bold text-amber">&gt;</span>
          <input
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            aria-label="Command line — type a product name or GPU asset"
            placeholder="terminal B200"
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            className="num w-16 min-w-0 bg-transparent px-2 text-[13px] font-bold text-amber outline-none placeholder:font-normal placeholder:text-dim sm:w-32"
          />
          <button
            type="submit"
            className="rev slug shrink-0 px-2.5 py-1 transition-opacity hover:opacity-85"
          >
            GO
          </button>
          <span
            role="status"
            aria-live="polite"
            className="slug ml-3 hidden truncate text-amber lg:inline"
          >
            {error ?? ""}
          </span>
        </form>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          <SessionControl />
          <Clock />
        </div>
      </div>
      {error && (
        <p
          role="status"
          aria-live="polite"
          className="border-t border-amber/40 bg-ground px-3 py-1 text-center lg:hidden"
        >
          <span className="slug text-amber">{error}</span>
        </p>
      )}
    </header>
  );
}

function Clock() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="num hidden text-[12px] text-data sm:inline" suppressHydrationWarning>
      {now == null ? "--:--:--" : fmtClock(now)}
    </span>
  );
}

function SessionControl() {
  const { auth } = useServices();
  const account = useAccount();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  if (!account.connected) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await auth.connect();
          } finally {
            setBusy(false);
          }
        }}
        className="slug border border-rule-strong px-2 py-1 text-dim transition-colors hover:border-amber hover:text-amber"
      >
        {busy ? "CONNECTING…" : "CONNECT"}
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className="rev slug px-2 py-1"
      >
        {account.label}
      </button>
      {open && (
        <>
          <div aria-hidden className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Account"
            className="absolute right-0 top-full z-50 mt-1.5 w-60 border border-rule-strong bg-panel p-3.5"
          >
            <p className="slug mb-2.5 text-dim">Connected · {account.label}</p>
            <dl className="space-y-1.5">
              <Row label={<Gusd />} value={fmtFull(account.gUsdBalance)} />
              <Row label={<SGusd />} value={fmtFull(account.sGUsdBalance)} />
              <Row label="Positions" value={String(account.positions.length)} />
            </dl>
            <button
              type="button"
              onClick={() => {
                auth.disconnect();
                setOpen(false);
              }}
              className="rev-d slug mt-3 w-full py-1.5"
            >
              Disconnect
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: ReactNode; value: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-rule pb-1.5">
      <dt className="slug text-dim">{label}</dt>
      <dd className="num text-[12.5px] text-data">{value}</dd>
    </div>
  );
}
