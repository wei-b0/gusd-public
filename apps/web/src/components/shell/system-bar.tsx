"use client";

/**
 * SystemBar — the machine's top rule: wordmark, command line, connection
 * control, live UTC clock. Present on every route. The command line speaks
 * the product's own names — markets, terminal H200, oracle, gusd — and a
 * bare GPU asset routes to that market's desk on the Terminal.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { parseAssetId, type WalletSession } from "@/domain/types";
import { fmtAddress, fmtClock, fmtFull } from "@/domain/format";
import { Gusd, SGusd } from "@/components/ui/pair";
import { useAccount, useServices, useWalletSession } from "@/data/services";
import { stableConfig } from "@/data/web3/stables";
import {
  chainIdFromCaip2,
  chainLabel,
  getActiveChain,
  isKnownChain,
} from "@/data/web3/chains";

/** The chain's reserve-asset symbol for the wallet readout. Fail-soft: the
 *  shell must render even where no stable config exists (no deployment). */
function stableSymbol(): string {
  try {
    return stableConfig().underlying.symbol;
  } catch {
    return "Stable";
  }
}

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
      // An asset argument names a market — and a market lives on the desk.
      return target ? `/terminal/${target}` : "/markets";
    case "terminal":
      return target ? `/terminal/${target}` : "/terminal";
    case "oracle":
      // Bare `oracle` lands on the Overview; an asset argument opens that
      // benchmark's board row and panel receipt.
      return target ? `/oracle?tab=benchmarks&bench=${target}` : "/oracle";
    case "index":
      return target ? `/oracle?tab=benchmarks&bench=${target}` : "/oracle?tab=benchmarks";
    case "data":
      return "/oracle?tab=developers";
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
      return parseAssetId(head) ? `/terminal/${parseAssetId(head)}` : null;
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
            placeholder="terminal H200"
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
          <ConnectControl />
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
      {/* The clock reads UTC — say so, quietly. */}
      <span className="ml-1 text-[10px] text-dim">UTC</span>
    </span>
  );
}

/**
 * ConnectControl — the one connection surface in the shell. Disconnected it
 * is a dim bordered CONNECT; connected it wears the wallet's address in
 * reverse video and opens the popover: wallet, network, balances, and the
 * disconnect action.
 */
function ConnectControl() {
  const { auth } = useServices();
  const account = useAccount();
  const session = useWalletSession();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const connecting = busy || session.status === "connecting";

  if (session.status !== "connected") {
    return (
      <button
        type="button"
        disabled={connecting}
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
        {connecting ? "CONNECTING…" : "CONNECT"}
      </button>
    );
  }

  const label = session.address ? fmtAddress(session.address) : (account.label ?? "connected");

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className="rev slug px-2 py-1"
      >
        {label}
      </button>
      {open && (
        <>
          <div aria-hidden className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Account"
            className="absolute right-0 top-full z-50 mt-1.5 w-60 border border-rule-strong bg-panel p-3.5"
          >
            <p className="slug mb-2.5 text-dim">Connected · {label}</p>
            {session.syncState === "expired" && (
              <p className="mb-2.5 border border-amber/40 bg-amber/10 px-2 py-1.5 text-[11.5px] leading-relaxed text-amber">
                Connection expired — reconnect.
              </p>
            )}
            <dl className="space-y-1.5">
              {session.address && <WalletRow address={session.address} />}
              {(session.address || session.chainId) && <NetworkRow session={session} />}
              <Row label={<Gusd />} value={fmtFull(account.gUsdBalance)} />
              <Row label={<SGusd />} value={fmtFull(account.sGUsdBalance)} />
              <Row label={stableSymbol()} value={fmtFull(account.stableBalance)} />
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

/** The wallet identity row: display address plus a copy-to-clipboard flash. */
function WalletRow({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function copy() {
    try {
      void navigator.clipboard.writeText(address).then(
        () => {
          if (timer.current) clearTimeout(timer.current);
          setCopied(true);
          timer.current = setTimeout(() => setCopied(false), 1_600);
        },
        () => {},
      );
    } catch {
      // Clipboard unavailable (insecure context) — the address stays readable.
    }
  }

  return (
    <div className="flex items-baseline justify-between border-b border-rule pb-1.5">
      <dt className="slug text-dim">Wallet</dt>
      <dd className="flex items-baseline gap-2">
        <span className="num text-[12.5px] text-data" title={address}>
          {fmtAddress(address)}
        </span>
        <button
          type="button"
          onClick={copy}
          className="slug text-dim transition-colors hover:text-amber"
        >
          {copied ? "COPIED" : "COPY"}
        </button>
      </dd>
    </div>
  );
}

/** The network row: the wallet's chain against the desk's one chain. */
function NetworkRow({ session }: { session: WalletSession }) {
  const active = getActiveChain();
  const walletChain = chainIdFromCaip2(session.chainId);

  let value: string;
  let lamp: "ok" | "wrong" | null = null;
  if (session.networkOk === true) {
    value = chainLabel(active.id) ?? active.name;
    lamp = "ok";
  } else if (session.networkOk === false) {
    value =
      walletChain != null ? (chainLabel(walletChain) ?? "unknown network") : "unknown network";
    lamp = "wrong";
  } else {
    value = "—";
  }

  return (
    <div className="flex items-baseline justify-between border-b border-rule pb-1.5">
      <dt className="slug text-dim">Network</dt>
      <dd className="num flex items-baseline gap-1.5 text-[12.5px] text-data">
        {lamp === "ok" && <span aria-label="on the active network" className="text-data">●</span>}
        {lamp === "wrong" && <span aria-label="on another network" className="text-amber">●</span>}
        <span>{value}</span>
      </dd>
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
