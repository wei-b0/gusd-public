"use client";

/**
 * gUSD — the settlement unit section. Two distinct product flows behind one
 * task switcher (TabBar), never stacked and never blended:
 *
 *   Get gUSD — any supported stable ⇄ gUSD on one surface. The desk prices
 *               the whole route — swap or bridge to the reserve asset, then
 *               the 1:1 mint — and runs every leg through one action path.
 *               Bridging and the en-route conversion are machinery: the
 *               ledger's route row and the bridge lane, never a second
 *               interface. Its tab also carries the mint activity ledger.
 *   Earn with sgUSD — liquid gUSD becomes earning capital. Its tab also
 *               carries the earning ledger.
 *
 * Minting never converts market positions at the Index — that model does
 * not exist in the product. Reading the page — the rates, the fees, the
 * activity — stays public; acting needs a wallet, and the desk's own CTA
 * is the connect button until one exists.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { isActionTerminal, type ActionOrigin, type ActionRecord } from "@/domain/actions";
import type { EarnDirection, EarnQuote } from "@/domain/types";
import { fmtClock, fmtFull, fmtGusdLedger, fmtGusdPrecise, fmtHash, fmtUnits, fmtUnitsMax } from "@/domain/format";
import { LedgerRow } from "@/components/ui/ledger";
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
import { useWalletActivity, useProtocolStats } from "@/data/protocol/hooks";
import { mergeActivity, vaultDeployedGusd, sgusdSupply, gusdNumber, type ActivityRow } from "@/data/protocol/map";
import { Gusd, SGusd } from "@/components/ui/pair";
import { TuiPanel } from "@/components/ui/panel";
import { GetDesk } from "@/components/gusd/get-desk";
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
        assets, receives the proceeds when positions sell, and deploys into sgUSD to earn. New
        gUSD enters through the desk below — from any supported stable, already here or
        bridged in from another chain; it exits by redeeming back.
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

          {/* Mint — the single funding surface and its receipts. Hidden, not
              unmounted, so the form survives a tab switch. */}
          <div
            role="tabpanel"
            aria-label="Get gUSD"
            hidden={desk !== "mint"}
            className="mt-6 space-y-6"
          >
            <GetDesk />
            <MintActivity />
          </div>

          {/* Earn — staking and its ledger */}
          <div
            role="tabpanel"
            aria-label="Earn with sgUSD"
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
        desc="Positions in H100, H200, L40S and peers — the productive layer."
        href="/"
      />
      <CapitalCell
        token="gUSD"
        role="Liquid capital"
        desc="The settlement unit. Acquires GPU assets and deploys into earning."
      />
      <CapitalCell
        token="sgUSD"
        role="Earning capital"
        desc={connected ? "gUSD deployed in the earning layer. Accrues continuously." : "gUSD deployed in the earning layer."}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 02 — Earn with sgUSD                                                */
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
  // never land a quote for an input that has since changed. The stale quote
  // clears up front: during the debounce the ledger shows "—", never the
  // previous direction's numbers.
  useEffect(() => {
    setSettled(null);
    setError(null);
    setQuote(null);
    if (!validAmount) return;
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

  // Stake presets off the liquid gUSD balance; unstake is shares-denominated,
  // so its base is the share balance itself.
  const presetBaseValue = direction === "stake" ? onchain.gUsd : onchain.sGusd;
  const presetBase = (frac: number) =>
    String(Math.floor(presetBaseValue * frac * 1e6) / 1e6);

  async function onSubmit() {
    setError(null);
    setSettled(null);
    try {
      const record =
        direction === "stake" ? await earnPort.deposit(amount) : await earnPort.redeem(amount);
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
            price is the yield; there is deliberately no APY figure. The
            two indexed cells print the earning layer's real size once the
            indexer stands behind this deployment (— before that). */}
        <dl className="grid grid-cols-2 gap-x-8 md:grid-cols-3">
          <Cell
            label={<><SGusd /> rate</>}
            value={earn.rate === null ? "—" : fmtGusdLedger(earn.rate)}
            sub={<><Gusd /> per <SGusd /></>}
            tone="bright"
          />
          <EarnVaultCells />
        </dl>

        <div className="mt-3.5 border-t border-rule pt-3.5">
          <p className="text-[11.5px] leading-relaxed text-dim">
            gUSD is liquid protocol capital; sgUSD is that same capital deployed into the
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
            Amount · {direction === "stake" ? <Gusd /> : <SGusd />}
          </span>
          {walletBound && (
            <span className="num text-[10.5px] text-dim">
              {direction === "stake"
                ? `liquid ${fmtGusdLedger(onchain.gUsd)} gUSD`
                : `earning ${fmtGusdLedger(onchain.sGusd)} sgUSD`}
            </span>
          )}
        </div>
        <div className="mt-1.5 flex items-stretch border border-rule-strong bg-ground focus-within:border-amber">
          <input
            type="text"
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value.replace(/[^0-9.]/g, ""))}
            aria-label={direction === "stake" ? "Amount in gUSD" : "Amount in sgUSD"}
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

        {/* Projection ledger — vault previews are execution-identical. The
            input names the leg the wallet signs: gUSD on stake, sgUSD
            shares on unstake; the quote prices the other leg. */}
        <dl className="mt-3.5 space-y-1.5 text-[12.5px]">
          <LedgerRow
            label={direction === "stake" ? "You stake" : "Shares burned"}
            value={
              validAmount
                ? `${fmtGusdLedger(amount)} ${direction === "stake" ? "gUSD" : "sgUSD"}`
                : "—"
            }
          />
          <LedgerRow
            label="You receive"
            value={
              quote
                ? direction === "stake"
                  ? `${fmtGusdLedger(quote.shares)} sgUSD`
                  : `${fmtGusdLedger(quote.assets)} gUSD`
                : "—"
            }
            strong
          />
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
/* 02 — Mint activity                                                  */
/* ------------------------------------------------------------------ */

/**
 * One desk's activity ledger: the indexed rows for its verbs merged with
 * this session's desk actions, newest first. Session cards fold away once
 * the indexer reflects their transactions (the indexed row tells the same
 * story with chain facts); in-flight cards always stay, and indexing lag
 * never renders as a failure.
 */
function ActivityLedger({
  no,
  title,
  verbs,
  origins,
  emptyCopy,
}: {
  no: string;
  title: string;
  verbs: readonly string[];
  origins: readonly ActionOrigin[];
  emptyCopy: string;
}) {
  const actions = useActions();
  const activity = useWalletActivity();
  const indexed = useMemo(
    () =>
      mergeActivity(activity.executions, activity.events, 100).filter((r) =>
        verbs.includes(r.verb),
      ),
    [activity.executions, activity.events, verbs],
  );
  const indexedHashes = useMemo(
    () => new Set(indexed.map((r) => r.txHash.toLowerCase())),
    [indexed],
  );
  const session = actions.filter(
    (r) =>
      origins.includes(r.origin) &&
      (!isActionTerminal(r.phase) ||
        !r.steps
          .flatMap((s) => (s.hash !== null ? [s.hash.toLowerCase()] : []))
          .some((h) => indexedHashes.has(h))),
  );
  const entries = [
    ...indexed.map((row) => ({ kind: "indexed" as const, key: row.id, t: row.t, row })),
    ...session.map((record) => ({
      kind: "session" as const,
      key: record.id,
      t: record.createdAt,
      record,
    })),
  ].sort((a, b) => b.t - a.t);
  const total = entries.length;
  return (
    <TuiPanel
      no={no}
      title={title}
      meta={
        indexed.length > 0
          ? `${total} entries · newest first`
          : total > 0
            ? `${total} this session`
            : "this session"
      }
    >
      <div className="border-t border-rule">
        {total === 0 ? (
          <p className="px-3.5 py-3 text-[11.5px] text-dim">{emptyCopy}</p>
        ) : (
          entries.map((e) =>
            e.kind === "indexed" ? (
              <IndexedLedgerRow key={e.key} row={e.row} />
            ) : (
              <ActionRow key={e.key} record={e.record} />
            ),
          )
        )}
      </div>
    </TuiPanel>
  );
}

function MintActivity() {
  return (
    <ActivityLedger
      no="02"
      title="Mint activity"
      verbs={["Mint", "Redeem"]}
      origins={["mint", "redeem"]}
      emptyCopy="Mints and redemptions print here once a wallet acts."
    />
  );
}

function ActionRow({ record }: { record: ActionRecord }) {
  // The chain hash of the action's most recent transaction — the record
  // linkage ids are the store's own and never print.
  const lastHash = [...record.steps].reverse().find((s) => s.hash)?.hash ?? null;
  const reflected =
    record.indexed !== null &&
    record.steps.some((s) => s.hash !== null && record.indexed!.includes(s.hash.toLowerCase()));
  return (
    <div aria-live="polite" className="border-b border-rule px-3.5 py-2 last:border-b-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="slug text-dim">{record.label}</span>
        <span className="flex items-baseline gap-1.5">
          {reflected && (
            <span className="slug border border-rule-strong px-1.5 py-0.5 text-[8.5px] text-dim">
              indexed
            </span>
          )}
          <PhaseTag phase={record.phase} />
        </span>
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

/** An indexed event/execution as the ledger prints it — chain hash, chain
 *  time, and the "indexed" provenance chip. */
function IndexedLedgerRow({ row }: { row: ActivityRow }) {
  const label =
    row.size !== null && row.asset !== null
      ? `${row.verb} ${fmtUnits(row.size)} ${row.asset}`
      : row.notional !== null
        ? `${row.verb} ${fmtGusdPrecise(row.notional)} gUSD`
        : row.verb;
  return (
    <div className="border-b border-rule px-3.5 py-2 last:border-b-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="slug text-dim">{label}</span>
        <span className="slug border border-rule-strong px-1.5 py-0.5 text-[8.5px] text-dim">
          indexed
        </span>
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="num text-[11px] text-dim">{fmtHash(row.txHash)}</span>
        <span className="num text-[11px] text-dim">{fmtClock(row.t)} UTC</span>
      </div>
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
    } catch {
      // A closed wallet modal is a normal exit, not an error state — the
      // panel just returns to its resting voice.
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
        <Row label={<>Earning · <SGusd /></>} value={fmtUnitsMax(account.sGUsdBalance)} />
        <Row label="Positions" value={`${account.positions.length} markets`} />
      </dl>
    </TuiPanel>
  );
}

function EarningLedger() {
  return (
    <ActivityLedger
      no="02"
      title="Earning ledger"
      verbs={["Stake", "Unstake"]}
      origins={["earn", "unearn"]}
      emptyCopy="Stakes and unstakes print here once a wallet acts."
    />
  );
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

/** The indexed vault-size cells for the Earn desk's public block — gUSD
 *  deployed by the vault, protocol revenue accrued to it, and the sgUSD
 *  supply. Inert without the indexer: all print "—" and take no space in
 *  mock mode. */
function EarnVaultCells() {
  const stats = useProtocolStats();
  const vault = stats?.vault ?? null;
  if (vault === null) return null;
  const deployed = vaultDeployedGusd(vault);
  const supply = sgusdSupply(vault);
  const revenue = gusdNumber(vault.revenueGusd);
  return (
    <>
      <Cell
        label={<>Vault deployed</>}
        value={deployed === null ? "—" : fmtGusdLedger(deployed)}
        sub="gUSD in the earning layer"
      />
      <Cell
        label="Revenue to vault"
        value={revenue === null ? "—" : fmtGusdLedger(revenue)}
        sub="accrued to stakers"
      />
      <Cell
        label={<><SGusd /> supply</>}
        value={supply === null ? "—" : `${fmtUnitsMax(supply)} sgUSD`}
        sub="minted − burned shares"
      />
    </>
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
