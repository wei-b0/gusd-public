"use client";

/**
 * gUSD — the settlement unit section. Two distinct product flows behind one
 * task switcher (TabBar), never stacked and never blended:
 *
 *   Mint gUSD — USDC ⇄ gUSD through the GUSD contract. Minting pulls USDC
 *               and mints gUSD net of the mint fee; redeeming burns gUSD
 *               and pays USDC net of the redeem fee. Quotes are the
 *               contract's own previews — the same math execution runs.
 *               Its tab also carries the mint activity ledger.
 *   Earn with sGUSD — liquid gUSD becomes earning capital. Its tab also
 *               carries the earning ledger.
 *
 * Minting never converts market positions at the Index — that model does
 * not exist in the product. Reading the page — the rates, the fees, the
 * activity — stays public; acting needs a wallet.
 */

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import type { ActionRecord } from "@/domain/actions";
import type { EarnDirection, EarnQuote, MintDirection, MintQuote } from "@/domain/types";
import { fmtClock, fmtFull, fmtGusdLedger, fmtHash } from "@/domain/format";
import { ActionStatus, PhaseTag } from "@/components/ui/action-status";
import { WalletlessNote } from "@/components/ui/walletless-note";
import {
  useAccount,
  useActions,
  useActiveAction,
  useEarn,
  useServices,
  useWalletSession,
} from "@/data/services";
import { getOnchainAccountStore, useOnchainAccount } from "@/data/onchain/account-store";
import { Gusd, SGusd } from "@/components/ui/pair";
import { TuiPanel } from "@/components/ui/panel";
import { TabBar } from "@/components/ui/tab-bar";

export default function GusdPage() {
  const account = useAccount();
  const [desk, setDesk] = useState<"mint" | "earn">("mint");
  // Deep link: /gusd?desk=earn opens the earn desk (portfolio and the
  // command line link straight to the flow they mean). Read from the
  // location on mount — a search-param hook would force the static
  // prerender dynamic for one query key.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("desk");
    if (requested === "earn" || requested === "mint") setDesk(requested);
  }, []);
  return (
    <div>
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-rule-strong pb-3">
        <h1 className="disp text-[22px] leading-none text-primary">gUSD</h1>
        <p className="slug text-dim">Settlement unit of the GPU markets</p>
      </header>

      <p className="max-w-prose text-[12.5px] leading-relaxed text-primary">
        Every GPU market settles in gUSD. gUSD is liquid protocol capital — it acquires GPU
        assets, receives the proceeds when positions sell, and deploys into sGUSD to earn. New
        gUSD enters by minting USDC into the protocol; it exits by redeeming back.
      </p>

      <div className="mt-5 border-b border-rule-strong pb-1">
        <ModelStrip connected={account.connected} />
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          {/* Two flows, one switch — the paths stay distinct */}
          <TabBar
            tabs={[
              { id: "mint", label: <>Mint <Gusd /></> },
              { id: "earn", label: <>Earn with <SGusd /></> },
            ]}
            active={desk}
            onChange={(t) => setDesk(t === "earn" ? "earn" : "mint")}
            label="gUSD flows"
          />

          {/* Mint — the issuance prototype and its receipts. Hidden, not
              unmounted, so the form survives a tab switch. */}
          <div
            role="tabpanel"
            aria-label="Mint gUSD"
            hidden={desk !== "mint"}
            className="mt-6 space-y-6"
          >
            <MintDesk />
            <MintActivity />
          </div>

          {/* Earn — staking and its ledger */}
          <div
            role="tabpanel"
            aria-label="Earn with sGUSD"
            hidden={desk !== "earn"}
            className="mt-6 space-y-6"
          >
            <EarnDesk />
            <EarningLedger />
          </div>
        </div>
        <div className="space-y-6">
          <Balances account={account} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The model strip — three capitals, one ledger                        */
/* ------------------------------------------------------------------ */

function CapitalCell({
  token,
  role,
  desc,
  href,
}: {
  token: string;
  role: string;
  desc: string;
  href?: string;
}) {
  return (
    <div className="border-b border-rule py-2.5">
      <p className="flex items-baseline justify-between gap-2">
        <span className="num text-[15px] font-bold text-bright">{token}</span>
        <span className="slug text-dim">{role}</span>
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-dim">{desc}</p>
      {href && (
        <Link href={href} className="slug mt-1.5 inline-block text-dim transition-colors hover:text-amber">
          {"Markets ▸"}
        </Link>
      )}
    </div>
  );
}

function ModelStrip({ connected }: { connected: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-3">
      <CapitalCell
        token="GPU markets"
        role="Market exposure"
        desc="Positions in H100, B200, A100 and peers — the productive layer."
        href="/markets"
      />
      <CapitalCell
        token="gUSD"
        role="Liquid capital"
        desc="The settlement unit. Acquires GPU assets and deploys into earning."
      />
      <CapitalCell
        token="sGUSD"
        role="Earning capital"
        desc={connected ? "gUSD deployed in the earning layer. Accrues continuously." : "gUSD deployed in the earning layer."}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 01 — Mint gUSD                                                      */
/* ------------------------------------------------------------------ */

/**
 * The mint desk — USDC ⇄ gUSD through the GUSD contract. Quotes are the
 * contract's own previews (execution-identical), so what the ledger shows
 * is what mintUSDC/redeemUSDC will do. Reading is public; acting needs the
 * wallet: one submit becomes the runner's plan (approval for mints, then
 * the action), and its live record fills the receipt slot.
 */
function MintDesk() {
  const { mint } = useServices();
  const session = useWalletSession();
  const onchain = useOnchainAccount(getOnchainAccountStore());
  const [direction, setDirection] = useState<MintDirection>("mint");
  const [amountText, setAmountText] = useState("1000");
  const [quote, setQuote] = useState<MintQuote | null>(null);
  const [settled, setSettled] = useState<ActionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One in-flight action per surface; both hooks stay mounted so hook order
  // never depends on the direction switch.
  const activeMint = useActiveAction("mint");
  const activeRedeem = useActiveAction("redeem");
  const active = direction === "mint" ? activeMint : activeRedeem;

  const connected = session.status === "connected";
  const walletBound = onchain.address !== null;
  const balance = direction === "mint" ? onchain.usdc : onchain.gUsd;
  const amount = Number(amountText);
  const validAmount = Number.isFinite(amount) && amount > 0;
  const paused = quote?.paused ?? false;
  const inputLabel = direction === "mint" ? "USDC" : "gUSD";
  const outputLabel = direction === "mint" ? "gUSD" : "USDC";

  // Previews are async contract reads — debounce the keystroke, cancel on
  // unmount, and never land a quote for an input that has since changed.
  useEffect(() => {
    setSettled(null);
    setError(null);
    if (!validAmount) {
      setQuote(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      mint
        .quote(direction, amount)
        .then((q) => {
          if (alive) setQuote(q);
        })
        .catch(() => {
          if (alive) setQuote(null);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [mint, direction, amount, validAmount]);

  async function onSubmit() {
    setError(null);
    setSettled(null);
    try {
      const record =
        direction === "mint" ? await mint.mint(amount) : await mint.redeem(amount);
      setSettled(record);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The transaction didn't start.");
    }
  }

  return (
    <TuiPanel
      no="01"
      title={
        <>
          Mint <Gusd />
        </>
      }
      meta="USDC ⇄ gUSD"
    >
      <div className="p-3.5">
        <p className="text-[11.5px] leading-relaxed text-dim">
          Minting pulls USDC and mints gUSD net of the mint fee; redeeming burns gUSD and pays
          USDC net of the redeem fee. The quotes below are the contract&apos;s own previews —
          the same math execution runs.
        </p>
        <div className="mt-3">
          <WalletlessNote />
        </div>
      </div>

      <div className="px-3.5 pb-3.5">
        {/* Direction */}
        <div className="grid grid-cols-2 border border-rule-strong" role="group" aria-label="Mint direction">
          {(["mint", "redeem"] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={direction === d}
              onClick={() => {
                setDirection(d);
                setAmountText("1000");
              }}
              className={`slug py-2.5 transition-colors ${
                direction === d ? (d === "mint" ? "rev-g" : "rev-d") : "text-dim hover:text-data"
              }`}
            >
              {d === "mint" ? (
                <>
                  Mint · USDC → <Gusd />
                </>
              ) : (
                <>
                  Redeem · <Gusd /> → USDC
                </>
              )}
            </button>
          ))}
        </div>

        {/* Amount */}
        <div className="mt-3.5 flex items-baseline justify-between">
          <span className="slug text-dim">Amount · {inputLabel}</span>
          {walletBound && (
            <span className="num text-[10.5px] text-dim">
              balance {fmtGusdLedger(balance)} {inputLabel}
            </span>
          )}
        </div>
        <div className="mt-1.5 flex items-stretch border border-rule-strong bg-ground focus-within:border-amber">
          <input
            type="text"
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value.replace(/[^0-9.]/g, ""))}
            aria-label={`Amount in ${inputLabel}`}
            className="num w-full bg-transparent px-3 py-2.5 text-[15px] text-data outline-none"
          />
          <div className="flex items-stretch border-l border-rule">
            {[0.25, 0.5, 1].map((frac) => (
              <button
                key={frac}
                type="button"
                disabled={!walletBound || balance <= 0}
                onClick={() => setAmountText(String(Number((balance * frac).toFixed(6))))}
                className="num border-l border-rule px-2.5 text-[11px] text-dim first:border-l-0 hover:text-amber disabled:cursor-not-allowed disabled:opacity-40"
              >
                {frac * 100}%
              </button>
            ))}
          </div>
        </div>

        {/* Quote ledger — previews are execution-identical, so these rows
            sum to the input at ledger precision */}
        <dl className="mt-3.5 space-y-1.5 text-[12.5px]">
          <LedgerRow
            label={direction === "mint" ? "You deposit" : "You redeem"}
            value={validAmount ? `${fmtGusdLedger(amount)} ${inputLabel}` : "—"}
          />
          <LedgerRow
            label={`Fee · ${quote ? (quote.feeBps / 100).toFixed(2) + "%" : "—"}`}
            value={quote ? `${fmtGusdLedger(quote.fee)} ${inputLabel}` : "—"}
          />
          <LedgerRow
            label="You receive"
            value={quote ? `${fmtGusdLedger(quote.output)} ${outputLabel}` : "—"}
            strong
          />
        </dl>

        {paused && (
          <p className="mt-3 text-[11.5px] leading-relaxed text-amber">
            {direction === "mint"
              ? "Minting is paused by the protocol operator — try again later."
              : "Redemption is paused by the protocol operator — try again later."}
          </p>
        )}

        {!connected && (
          <p className="mt-3 text-[11.5px] leading-relaxed text-dim">
            Connect a wallet to mint — nothing signs without one.
          </p>
        )}

        {(active ?? settled) && <ActionStatus record={(active ?? settled) as ActionRecord} />}

        {error && (
          <p role="alert" className="mt-3 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={onSubmit}
          disabled={active !== null || !validAmount || paused || !connected}
          className={`slug mt-3.5 w-full py-2.5 text-rev-fg transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${
            direction === "mint" ? "rev-g hover:opacity-90" : "border border-down text-down hover:bg-down/10"
          }`}
        >
          {active !== null ? (
            "Working…"
          ) : direction === "mint" ? (
            <>
              Mint <Gusd />
            </>
          ) : (
            <>Redeem for USDC</>
          )}
        </button>
      </div>
    </TuiPanel>
  );
}

/* ------------------------------------------------------------------ */
/* 02 — Earn with sGUSD                                                */
/* ------------------------------------------------------------------ */

/**
 * The earn desk — gUSD into the sgUSD vault and back. Previews are the
 * contract's own ERC-4626 math, so the ledger shows what deposit/withdraw
 * will do; the share price is the yield, and no APY is invented. Reading
 * is public; acting needs the wallet: one submit becomes the runner's plan
 * (gUSD approval for stakes, then the action), and its live record fills
 * the receipt slot.
 */
function EarnDesk() {
  const { earn: earnPort } = useServices();
  const earn = useEarn();
  const session = useWalletSession();
  const onchain = useOnchainAccount(getOnchainAccountStore());
  const [direction, setDirection] = useState<EarnDirection>("stake");
  const [amountText, setAmountText] = useState("1000");
  const [quote, setQuote] = useState<EarnQuote | null>(null);
  const [settled, setSettled] = useState<ActionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeStake = useActiveAction("earn");
  const activeUnstake = useActiveAction("unearn");
  const active = direction === "stake" ? activeStake : activeUnstake;

  const connected = session.status === "connected";
  const walletBound = onchain.address !== null;
  const amount = Number(amountText);
  const validAmount = Number.isFinite(amount) && amount > 0;
  const seeded = earn.seeded !== false;

  // Vault previews are async contract reads — debounce, cancel on unmount,
  // never land a quote for an input that has since changed.
  useEffect(() => {
    setSettled(null);
    setError(null);
    if (!validAmount) {
      setQuote(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      earnPort
        .quote(direction, amount)
        .then((q) => {
          if (alive) setQuote(q);
        })
        .catch(() => {
          if (alive) setQuote(null);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [earnPort, direction, amount, validAmount]);

  // The share price is the yield — re-read the vault after an action lands.
  useEffect(() => {
    if (active === null && settled !== null) void earnPort.refresh();
  }, [active, settled, earnPort]);

  // Stake presets off the liquid gUSD balance; unstake is assets-denominated,
  // so its base is the earning position valued at the current share price.
  const presetBaseValue =
    direction === "stake" ? onchain.gUsd : onchain.sGusd * (earn.rate ?? 0);
  const presetBase = (frac: number) =>
    String(Math.floor(presetBaseValue * frac * 1e6) / 1e6);

  async function onSubmit() {
    setError(null);
    setSettled(null);
    try {
      const record =
        direction === "stake" ? await earnPort.deposit(amount) : await earnPort.withdraw(amount);
      setSettled(record);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The transaction didn't start.");
    }
  }

  return (
    <TuiPanel
      no="01"
      title={
        <>
          Earn with <SGusd />
        </>
      }
      meta="gUSD deployed in the earning layer"
    >
      <div className="p-3.5">
        {/* Public rate block — readable before any connection. The share
            price is the yield; there is deliberately no APY figure. */}
        <dl className="grid grid-cols-2 gap-x-8 md:grid-cols-3">
          <Cell
            label={<><SGusd /> rate</>}
            value={earn.rate === null ? "—" : fmtGusdLedger(earn.rate)}
            sub={<><Gusd /> per <SGusd /></>}
            tone="bright"
          />
        </dl>

        <div className="mt-3.5 border-t border-rule pt-3.5">
          <p className="text-[11.5px] leading-relaxed text-dim">
            gUSD is liquid protocol capital; sGUSD is that same capital deployed into the
            earning layer. Staked gUSD earns continuously and unstakes back at the prevailing
            rate.
          </p>
          <div className="mt-3">
            <WalletlessNote />
          </div>
        </div>

        {/* Direction */}
        <div className="mt-3.5 grid grid-cols-2 border border-rule-strong" role="group" aria-label="Earn direction">
          {(["stake", "unstake"] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={direction === d}
              onClick={() => {
                setDirection(d);
                setAmountText(d === "stake" ? "1000" : "500");
              }}
              className={`slug py-2.5 transition-colors ${
                direction === d ? (d === "stake" ? "rev-g" : "rev-d") : "text-dim hover:text-data"
              }`}
            >
              {d === "stake" ? (
                <>Stake · <Gusd /> → <SGusd /></>
              ) : (
                <>Unstake · <SGusd /> → <Gusd /></>
              )}
            </button>
          ))}
        </div>

        {/* Amount */}
        <div className="mt-3.5 flex items-baseline justify-between">
          <span className="slug text-dim">
            Amount · <Gusd />
          </span>
          {walletBound && (
            <span className="num text-[10.5px] text-dim">
              {direction === "stake"
                ? `liquid ${fmtGusdLedger(onchain.gUsd)} gUSD`
                : `earning ${fmtGusdLedger(onchain.sGusd)} sGUSD`}
            </span>
          )}
        </div>
        <div className="mt-1.5 flex items-stretch border border-rule-strong bg-ground focus-within:border-amber">
          <input
            type="text"
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value.replace(/[^0-9.]/g, ""))}
            aria-label="Amount in gUSD"
            className="num w-full bg-transparent px-3 py-2.5 text-[15px] text-data outline-none"
          />
          <div className="flex items-stretch border-l border-rule">
            {[0.25, 0.5, 1].map((frac) => (
              <button
                key={frac}
                type="button"
                disabled={!walletBound || presetBaseValue <= 0}
                onClick={() => setAmountText(presetBase(frac))}
                className="num border-l border-rule px-2.5 text-[11px] text-dim first:border-l-0 hover:text-amber disabled:cursor-not-allowed disabled:opacity-40"
              >
                {frac * 100}%
              </button>
            ))}
          </div>
        </div>

        {/* Projection ledger — vault previews are execution-identical */}
        <dl className="mt-3.5 space-y-1.5 text-[12.5px]">
          <LedgerRow
            label={direction === "stake" ? "You stake" : "You unstake"}
            value={validAmount ? `${fmtGusdLedger(amount)} gUSD` : "—"}
          />
          <LedgerRow
            label={direction === "stake" ? "You receive" : "Shares burned"}
            value={quote ? `${fmtGusdLedger(quote.shares)} sGUSD` : "—"}
            strong={direction === "stake"}
          />
          {direction === "unstake" && (
            <LedgerRow
              label="You receive"
              value={validAmount ? `${fmtGusdLedger(amount)} gUSD` : "—"}
              strong
            />
          )}
        </dl>

        {earn.seeded === false && (
          <p className="mt-3 text-[11.5px] leading-relaxed text-amber">
            The vault hasn&apos;t been seeded yet — deposits open once it holds its seed.
          </p>
        )}

        {!connected && (
          <p className="mt-3 text-[11.5px] leading-relaxed text-dim">
            Connect a wallet to earn — nothing signs without one.
          </p>
        )}

        {(active ?? settled) && <ActionStatus record={(active ?? settled) as ActionRecord} />}

        {error && (
          <p role="alert" className="mt-3 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={onSubmit}
          disabled={active !== null || !validAmount || !seeded || !connected}
          className={`slug mt-3.5 w-full py-2.5 text-rev-fg transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${
            direction === "stake" ? "rev-g hover:opacity-90" : "border border-down text-down hover:bg-down/10"
          }`}
        >
          {active !== null ? (
            "Working…"
          ) : direction === "stake" ? (
            <>
              Stake <Gusd />
            </>
          ) : (
            <>
              Unstake <SGusd />
            </>
          )}
        </button>
      </div>
    </TuiPanel>
  );
}

function Cell({
  label,
  value,
  sub,
  tone = "data",
}: {
  label: ReactNode;
  value: string;
  sub?: ReactNode;
  tone?: "data" | "bright" | "up" | "dim";
}) {
  const toneClass = { data: "text-data", bright: "text-bright", up: "text-up", dim: "text-dim" }[tone];
  return (
    <div className="border-b border-rule py-2">
      <dt className="slug text-dim">{label}</dt>
      <dd className={`num mt-1 text-[16px] font-bold ${toneClass}`}>{value}</dd>
      {sub && <dd className="num mt-0.5 text-[10px] text-dim">{sub}</dd>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 03 — Mint activity                                                  */
/* ------------------------------------------------------------------ */

/**
 * This session's mint-desk actions, newest first — mints and redemptions
 * with their live phases and receipt hashes. Session-local evidence, never
 * a portfolio or history source.
 */
function MintActivity() {
  const actions = useActions();
  const rows = actions.filter((r) => r.origin === "mint" || r.origin === "redeem");
  return (
    <TuiPanel no="02" title="Mint activity" meta={rows.length ? `${rows.length} this session` : "this session"}>
      <div className="border-t border-rule">
        {rows.length === 0 ? (
          <p className="px-3.5 py-3 text-[11.5px] text-dim">Mints and redemptions print here once a wallet acts.</p>
        ) : (
          rows.map((r) => <ActionRow key={r.id} record={r} />)
        )}
      </div>
    </TuiPanel>
  );
}

function ActionRow({ record }: { record: ActionRecord }) {
  // The chain hash of the action's most recent transaction — the record
  // linkage ids are the store's own and never print.
  const lastHash = [...record.steps].reverse().find((s) => s.hash)?.hash ?? null;
  return (
    <div aria-live="polite" className="border-b border-rule px-3.5 py-2 last:border-b-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="slug text-dim">{record.label}</span>
        <PhaseTag phase={record.phase} />
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="num text-[11px] text-dim">{lastHash ? fmtHash(lastHash) : "—"}</span>
        <span className="num text-[11px] text-dim">{fmtClock(record.updatedAt)} UTC</span>
      </div>
      {record.error && (
        <p className="mt-1.5 border border-amber/40 bg-amber/10 p-2 text-[11px] leading-relaxed text-amber">
          {record.error}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Right rail — balances and the earning ledger                        */
/* ------------------------------------------------------------------ */

function Balances({ account }: { account: ReturnType<typeof useAccount> }) {
  const { auth } = useServices();
  const [connecting, setConnecting] = useState(false);

  async function onConnect() {
    setConnecting(true);
    try {
      await auth.connect();
    } finally {
      setConnecting(false);
    }
  }

  if (!account.connected) {
    return (
      <TuiPanel title="Balances">
        <div className="p-3.5">
          <span className="slug border border-rule-strong px-1.5 py-0.5 text-[9px] text-dim">
            Not connected
          </span>
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-dim">
            Connect to mint, stake, and see your balances.
          </p>
          <button
            type="button"
            onClick={onConnect}
            disabled={connecting}
            className="rev slug mt-3 w-full py-2.5 text-rev-fg transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {connecting ? "Connecting…" : (
              <>
                Access <Gusd />
              </>
            )}
          </button>
        </div>
      </TuiPanel>
    );
  }

  return (
    <TuiPanel title="Balances" meta={account.label ?? undefined}>
      <dl className="p-3.5">
        <Row label={<>Liquid · <Gusd /></>} value={fmtFull(account.gUsdBalance)} />
        <Row label={<>Earning · <SGusd /></>} value={fmtFull(account.sGUsdBalance)} />
        <Row label="Positions" value={`${account.positions.length} markets`} />
      </dl>
    </TuiPanel>
  );
}

function EarningLedger() {
  const actions = useActions();
  const rows = actions.filter((r) => r.origin === "earn" || r.origin === "unearn");
  return (
    <TuiPanel no="02" title="Earning ledger" meta={rows.length ? `${rows.length} this session` : "this session"}>
      <div className="border-t border-rule">
        {rows.length === 0 ? (
          <p className="px-3.5 py-3 text-[11.5px] text-dim">Stakes and unstakes print here once a wallet acts.</p>
        ) : (
          rows.map((r) => <ActionRow key={r.id} record={r} />)
        )}
      </div>
    </TuiPanel>
  );
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

function LedgerRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className={`slug ${strong ? "text-bright" : "text-dim"}`}>{label}</dt>
      <dd className={`num ${strong ? "text-[14px] font-bold text-bright" : "text-[12.5px] text-data"}`}>
        {value}
      </dd>
    </div>
  );
}

function Row({ label, value }: { label: ReactNode; value: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-rule py-2 last:border-b-0">
      <dt className="slug text-dim">{label}</dt>
      <dd className="num text-[12.5px] text-data">{value}</dd>
    </div>
  );
}
