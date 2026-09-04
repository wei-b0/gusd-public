"use client";

/**
 * gUSD — the settlement unit section. Two distinct product flows behind one
 * task switcher (TabBar), never stacked and never blended:
 *
 *   Mint gUSD — deposit a supported asset into the protocol's issuance
 *               mechanism and receive minted gUSD. The mechanism (deposit
 *               catalogue, collateral rules, fees, constraints) is not
 *               finalized: the prototype keeps its inputs generic and
 *               previews at a 1:1 placeholder rate, and says so.
 *               Its tab also carries the mint activity ledger.
 *   Earn with sGUSD — liquid gUSD becomes earning capital. Its tab also
 *               carries the earning ledger.
 *
 * Minting never converts market positions at the Index — that model does
 * not exist in the product. Reading the page — the model, the rates, the
 * activity — stays public; acting needs a connection.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import type {
  DepositAssetId,
  EarnReceipt,
  EarnState,
  MintQuote,
  MintReceipt,
} from "@/domain/types";
import { DEPOSIT_ASSET_IDS, depositAssetName } from "@/domain/types";
import { fmtFull, fmtGusd, fmtStamp, fmtUnits } from "@/domain/format";
import { useAccount, useEarn, useMintActivity, useServices } from "@/data/services";
import { Gusd, SGusd } from "@/components/ui/pair";
import { TuiPanel } from "@/components/ui/panel";
import { TabBar } from "@/components/ui/tab-bar";

type MintStatus =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; receipt: MintReceipt }
  | { kind: "error"; message: string };

type EarnStatus =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; receipt: EarnReceipt }
  | { kind: "error"; message: string };

export default function GusdPage() {
  const account = useAccount();
  const earn = useEarn();
  const [desk, setDesk] = useState<"mint" | "earn">("mint");
  return (
    <div>
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-rule-strong pb-3">
        <h1 className="disp text-[22px] leading-none text-primary">gUSD</h1>
        <p className="slug text-dim">Settlement unit of the GPU markets</p>
      </header>

      <p className="max-w-prose text-[12.5px] leading-relaxed text-primary">
        Every GPU market settles in gUSD. gUSD is liquid protocol capital — it acquires GPU
        assets, receives the proceeds when positions sell, and deploys into sGUSD to earn. New
        gUSD enters through the protocol&apos;s issuance mechanism, previewed below.
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
            <MintDesk account={account} />
            <MintActivity />
          </div>

          {/* Earn — staking and its ledger */}
          <div
            role="tabpanel"
            aria-label="Earn with sGUSD"
            hidden={desk !== "earn"}
            className="mt-6 space-y-6"
          >
            <EarnDesk earn={earn} account={account} />
            <EarningLedger earn={earn} account={account} />
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

function MintDesk({ account }: { account: ReturnType<typeof useAccount> }) {
  const { mint } = useServices();
  const [asset, setAsset] = useState<DepositAssetId>("A");
  const [amountText, setAmountText] = useState("1000");
  const [status, setStatus] = useState<MintStatus>({ kind: "idle" });

  const amount = Number(amountText);
  const validAmount = Number.isFinite(amount) && amount > 0;
  const quote: MintQuote | null = useMemo(
    () => (validAmount ? mint.quote(asset, amount) : null),
    [mint, asset, amount, validAmount],
  );

  useEffect(() => {
    setStatus((s) => (s.kind === "done" ? { kind: "idle" } : s));
  }, [amountText, asset]);

  async function onSubmit() {
    if (!validAmount) {
      setStatus({ kind: "error", message: "Enter a deposit amount greater than zero." });
      return;
    }
    setStatus({ kind: "working" });
    try {
      const receipt = await mint.mint(asset, amount);
      setStatus({ kind: "done", receipt });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "The mint failed. Adjust it and try again.",
      });
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
      meta="issuance · prototype"
      right={<span className="slug border border-rule-strong px-1.5 py-0.5 text-[9px] text-amber">Prototype</span>}
    >
      <div className="p-3.5">
        <p className="text-[11.5px] leading-relaxed text-dim">
          Deposits enter the protocol&apos;s issuance mechanism and mint gUSD. That mechanism —
          which assets are supported, collateral rules, fees, and issuance constraints — is
          still being specified, so this prototype keeps its inputs generic.
        </p>
      </div>

      <div className="px-3.5 pb-3.5">
        {/* Deposit asset — placeholders until the catalogue is specified */}
        <div>
          <p className="slug text-dim">Deposit asset</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="Deposit asset">
            {DEPOSIT_ASSET_IDS.map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={asset === id}
                onClick={() => setAsset(id)}
                className={`num border px-2.5 py-1.5 text-[12px] whitespace-nowrap transition-colors ${
                  asset === id
                    ? "border-amber text-amber"
                    : "border-rule-strong text-dim hover:border-rule-strong hover:text-data"
                }`}
              >
                {depositAssetName(id)}
              </button>
            ))}
          </div>
          <p className="num mt-1.5 text-[10.5px] text-dim">
            supported deposit assets are still being specified
          </p>
        </div>

        {/* Amount */}
        <div className="mt-3.5">
          <span className="slug text-dim">Amount</span>
        </div>
        <div className="mt-1.5 flex items-stretch border border-rule-strong bg-ground focus-within:border-amber">
          <input
            type="text"
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value.replace(/[^0-9.]/g, ""))}
            aria-label={`Deposit amount in ${depositAssetName(asset)} units`}
            className="num w-full bg-transparent px-3 py-2.5 text-[15px] text-data outline-none"
          />
        </div>

        {/* Quote ledger — the transaction information a mint would review */}
        <dl className="mt-3.5 space-y-1.5 text-[12.5px]">
          <LedgerRow
            label="You deposit"
            value={validAmount ? `${fmtUnits(amount)} ${depositAssetName(asset)}` : "—"}
          />
          <LedgerRow label="Issuance mechanism" value="prototype — unspecified" />
          <LedgerRow label="Fee" value="not finalized" />
          <LedgerRow
            label="Expected gUSD"
            value={quote ? fmtGusd(quote.gUsd) : "—"}
            strong
          />
        </dl>

        {!account.connected && (
          <p className="mt-3 text-[11.5px] leading-relaxed text-dim">
            Connect to mint — demo capital is provided once connected.
          </p>
        )}

        {status.kind === "error" && (
          <p className="mt-3 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
            {status.message}
          </p>
        )}

        {status.kind === "done" && (
          <div className="mt-3 border border-rule-strong bg-panel-deep p-2.5">
            <p className="rev slug mb-2 inline-block px-1.5 py-0.5 text-[9.5px]">Minted</p>
            <p className="num text-[11.5px] leading-relaxed text-data">
              Minted {fmtGusd(status.receipt.gUsdMoved)} · {depositAssetName(status.receipt.depositAsset)}{" "}
              deposit · {fmtStamp(status.receipt.t)}
            </p>
          </div>
        )}

        <button
          type="button"
          onClick={onSubmit}
          disabled={status.kind === "working" || !validAmount || !account.connected}
          className="rev-g slug mt-3.5 w-full py-2.5 text-rev-fg transition-opacity disabled:cursor-not-allowed disabled:opacity-40 hover:opacity-90"
        >
          {status.kind === "working" ? (
            "Minting…"
          ) : (
            <>
              Mint <Gusd />
            </>
          )}
        </button>

        <p className="mt-3 text-[11px] leading-relaxed text-amber">
          The 1:1 preview is a placeholder, not a protocol rate. Deposit assets, collateral
          rules, fees, and issuance constraints land with the protocol specification.
        </p>
      </div>
    </TuiPanel>
  );
}

/* ------------------------------------------------------------------ */
/* 02 — Earn with sGUSD                                                */
/* ------------------------------------------------------------------ */

function EarnDesk({ earn, account }: { earn: EarnState; account: ReturnType<typeof useAccount> }) {
  const { earn: earnPort } = useServices();
  const [direction, setDirection] = useState<"stake" | "unstake">("stake");
  const [amountText, setAmountText] = useState("1000");
  const [status, setStSt] = useState<EarnStatus>({ kind: "idle" });

  const amount = Number(amountText);
  const validAmount = Number.isFinite(amount) && amount > 0;

  useEffect(() => {
    setStSt((s) => (s.kind === "done" ? { kind: "idle" } : s));
  }, [amountText, direction]);

  async function onSubmit() {
    if (!validAmount) {
      setStSt({ kind: "error", message: "Enter an amount greater than zero." });
      return;
    }
    setStSt({ kind: "working" });
    try {
      const receipt =
        direction === "stake" ? await earnPort.deposit(amount) : await earnPort.withdraw(amount);
      setStSt({ kind: "done", receipt });
    } catch (err) {
      setStSt({
        kind: "error",
        message: err instanceof Error ? err.message : "The transaction failed. Adjust it and try again.",
      });
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
      right={
        <span className="num text-[12px] font-bold text-amber">
          Trailing 30d APY {earn.trailingApyPct.toFixed(2)}%
          <span className="slug ml-1.5 border border-rule-strong px-1 py-0.5 text-[8.5px] font-normal">Prototype</span>
        </span>
      }
    >
      <div className="p-3.5">
        {/* Public rate block — readable before any connection */}
        <dl className="grid grid-cols-2 gap-x-8 md:grid-cols-3">
          <Cell label="Trailing 30d APY" value={`${earn.trailingApyPct.toFixed(2)}%`} tone="bright" />
          <Cell
            label={<><SGusd /> rate</>}
            value={earn.rate.toFixed(5)}
            sub={<><Gusd /> per <SGusd /></>}
          />
          <Cell
            label="Accrued"
            value={account.connected ? `+${fmtFull(earn.accruedUsd)}` : "—"}
            tone={account.connected ? "up" : "dim"}
          />
        </dl>

        <div className="mt-3.5 border-t border-rule pt-3.5">
          <p className="text-[11.5px] leading-relaxed text-dim">
            gUSD is liquid protocol capital; sGUSD is that same capital deployed into the
            earning layer. Staked gUSD earns continuously and unstakes back at the prevailing
            rate.
          </p>
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
          {account.connected && (
            <span className="num text-[10.5px] text-dim">
              {direction === "stake"
                ? `liquid ${fmtFull(account.gUsdBalance)}`
                : `earning ${fmtFull(earn.sGUsdValueUsd)}`}
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
                disabled={!account.connected}
                onClick={() => {
                  const base = direction === "stake" ? account.gUsdBalance : earn.sGUsdValueUsd;
                  if (base > 0) setAmountText(String(+(base * frac).toFixed(2)));
                }}
                className="num border-l border-rule px-2.5 text-[11px] text-dim first:border-l-0 hover:text-amber disabled:cursor-not-allowed disabled:opacity-40"
              >
                {frac * 100}%
              </button>
            ))}
          </div>
        </div>

        {/* Projection ledger */}
        <dl className="mt-3.5 space-y-1.5 text-[12.5px]">
          <LedgerRow
            label={direction === "stake" ? "You stake" : "You unstake"}
            value={validAmount ? fmtGusd(amount) : "—"}
          />
          <LedgerRow
            label="You receive"
            value={
              validAmount
                ? direction === "stake"
                  ? `${fmtFull(amount / earn.rate)} sGUSD`
                  : fmtGusd(amount * earn.rate)
                : "—"
            }
            strong
          />
        </dl>

        {!account.connected && (
          <p className="mt-3 text-[11.5px] leading-relaxed text-dim">
            Connect to stake — demo capital is provided once connected.
          </p>
        )}

        <p aria-live="polite" className="mt-1">
          {status.kind === "error" && (
            <span className="mt-3 block border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
              {status.message}
            </span>
          )}
          {status.kind === "done" && (
            <span className="mt-3 block border border-rule-strong bg-panel-deep p-2.5 text-[11.5px] leading-relaxed text-up">
              {status.receipt.kind === "deposit"
                ? `Staked ${fmtGusd(status.receipt.gUsdMoved)} → ${fmtFull(status.receipt.sGUsdMoved)} sGUSD at ${status.receipt.rate.toFixed(5)}`
                : `Unstaked ${fmtFull(status.receipt.sGUsdMoved)} sGUSD → ${fmtGusd(status.receipt.gUsdMoved)} at ${status.receipt.rate.toFixed(5)}`}
            </span>
          )}
        </p>

        <button
          type="button"
          onClick={onSubmit}
          disabled={status.kind === "working" || !validAmount || !account.connected}
          className={`slug mt-3.5 w-full py-2.5 text-rev-fg transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${
            direction === "stake" ? "rev-g hover:opacity-90" : "border border-down text-down hover:bg-down/10"
          }`}
        >
          {status.kind === "working" ? (
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

        <p className="mt-3 text-[11px] leading-relaxed text-amber">
          The trailing 30d APY is prototype data, not a yield claim. Earning mechanics land with
          the protocol.
        </p>
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

function MintActivity() {
  const receipts = useMintActivity();
  const rows = [...receipts].reverse();
  return (
    <TuiPanel no="02" title="Mint activity" meta={rows.length ? `${rows.length} mints` : "no mints yet"}>
      <div className="border-t border-rule">
        {rows.length === 0 ? (
          <p className="px-3.5 py-3 text-[11.5px] text-dim">Mints print here once connected.</p>
        ) : (
          rows.map((r, i) => (
            <div
              key={`${r.t}-${i}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-rule px-3.5 py-1.5 last:border-b-0"
            >
              <span className="num w-16 shrink-0 text-[11px] text-dim">{fmtStamp(r.t)}</span>
              <span className="slug w-14 shrink-0 text-up">Mint</span>
              <span className="num flex-1 text-right text-[12px] text-data">
                {`${fmtUnits(r.amount)} ${depositAssetName(r.depositAsset)} → ${fmtGusd(r.gUsdMoved)}`}
              </span>
            </div>
          ))
        )}
      </div>
    </TuiPanel>
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
            Connect to mint, stake, and see your balances. Demo capital is provided.
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

function EarningLedger({ earn, account }: { earn: EarnState; account: ReturnType<typeof useAccount> }) {
  const rows = [...earn.receipts].reverse();
  return (
    <TuiPanel no="02" title="Earning ledger" meta={account.connected ? undefined : "not connected"}>
      <div className="border-t border-rule">
        {rows.length === 0 ? (
          <p className="px-3.5 py-3 text-[11.5px] text-dim">Stakes and unstakes print here.</p>
        ) : (
          rows.map((r, i) => {
            const isIn = r.kind === "deposit";
            return (
              <div
                key={`${r.t}-${i}`}
                className="flex items-baseline gap-x-3 border-b border-rule px-3.5 py-1.5 last:border-b-0"
              >
                <span className={`slug w-10 shrink-0 ${isIn ? "text-up" : "text-down"}`}>
                  {isIn ? "In" : "Out"}
                </span>
                <span className="num flex-1 text-right text-[12px] text-data">
                  {fmtGusd(r.gUsdMoved)} → {fmtFull(r.sGUsdMoved)} sGUSD
                </span>
              </div>
            );
          })
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
