"use client";

/**
 * The Get gUSD desk — the mint tab's single surface. One picker states where
 * value starts, currency first — the token the user holds — then the chain
 * that carries it (the deployment chain by its own name, then bridge-served
 * origins). One composed ledger states what lands in gUSD, one CTA runs
 * every leg. Bridging and the en-route conversion are machinery the desk
 * performs, never a second interface: they surface only as the ledger's
 * ROUTE row and the execution lane's first step. A remote quote composes the
 * bridge's floor with the mint's own preview — receive and floor are the two
 * legs multiplied, never invented. Reading is public (local quotes price
 * without a wallet); acting needs one: the CTA is the connect button until
 * the wallet exists, so onboarding never leaves the desk.
 */

import { useEffect, useState } from "react";
import type { Address } from "viem";
import type { ActionRecord } from "@/domain/actions";
import type { BridgeOrigin, BridgeProgress, BridgeQuote, BridgeToken } from "@/domain/bridge";
import { runBridgeToMint } from "@/domain/bridge";
import type { MintDirection, MintQuote } from "@/domain/types";
import { fmtGusdLedger, fmtHash } from "@/domain/format";
import { formatStableRaw } from "@/domain/units";
import { LedgerRow } from "@/components/ui/ledger";
import { ActionStatus } from "@/components/ui/action-status";
import { WalletlessNote } from "@/components/ui/walletless-note";
import { Gusd } from "@/components/ui/pair";
import { TuiPanel } from "@/components/ui/panel";
import { useActiveAction, useServices, useWalletSession } from "@/data/services";
import { getOnchainAccountStore, useOnchainAccount } from "@/data/onchain/account-store";
import { stablesFor, stableConfig, stableLabel, type StableMeta } from "@/data/web3/stables";
import { contractReads } from "@/data/web3/reads";
import { chainCapabilities, chainLabel, getActiveChain } from "@/data/web3/chains";
import { getContracts } from "@/data/web3/contracts";
import { DEMO_FUND } from "@/data/demo";

/** Where value starts — a whitelisted stable on the deployment chain, or a
 *  bridge-served origin token. The desk treats both as one more chip. */
type Source =
  | { kind: "local"; asset: StableMeta }
  | { kind: "remote"; chainId: number; chainLabel: string; token: { address: Address; symbol: string } };

/** One place a currency can come from: a whitelisted stable here, or an
 *  origin token across the bridge. */
type CurrencyEntry =
  | { kind: "local"; asset: StableMeta }
  | { kind: "remote"; origin: BridgeOrigin; token: BridgeToken };

/** A currency the desk accepts, with every chain that carries it — the unit
 *  the user thinks in ("I have USDC"), ahead of the plumbing ("from where"). */
type CurrencyOption = { symbol: string; entries: CurrencyEntry[] };

/** Merge local stables and bridge origins into one currency list. Local
 *  stables lead (reserve first — the home asset), origin tokens merge in by
 *  symbol; remote-only currencies follow in origin order. */
function currencyOptions(localAssets: StableMeta[], origins: BridgeOrigin[]): CurrencyOption[] {
  const out: CurrencyOption[] = localAssets.map((asset) => ({
    symbol: asset.symbol,
    entries: [{ kind: "local", asset }],
  }));
  for (const origin of origins) {
    for (const token of origin.tokens) {
      const known = out.find((c) => c.symbol === token.symbol);
      if (known) known.entries.push({ kind: "remote", origin, token });
      else out.push({ symbol: token.symbol, entries: [{ kind: "remote", origin, token }] });
    }
  }
  return out;
}

/** The desk's own run state — the bridge leg lives here (bridging is not a
 *  protocol action); the mint leg is an ordinary action record. */
type DeskRun =
  | { kind: "idle" }
  | { kind: "bridging"; progress: BridgeProgress }
  | { kind: "minting" }
  | { kind: "failed"; error: string };

export function GetDesk() {
  const { auth, mint, bridge } = useServices();
  const session = useWalletSession();
  const onchain = useOnchainAccount(getOnchainAccountStore());

  const localAssets = localStables();
  const origins = remoteOrigins(bridge);
  const [direction, setDirection] = useState<MintDirection>("mint");
  // Currency first, then the chain that carries it. Redemption pays out on
  // the deployment chain, so its currency list drops remote entries.
  const currencies =
    direction === "mint" ? currencyOptions(localAssets, origins) : currencyOptions(localAssets, []);
  const [currencyIdx, setCurrencyIdx] = useState(0);
  const [whereIdx, setWhereIdx] = useState(0);
  const [amountText, setAmountText] = useState("1000");
  const [bridgeQuote, setBridgeQuote] = useState<BridgeQuote | null>(null);
  const [mintQuote, setMintQuote] = useState<MintQuote | null>(null);
  const [pricing, setPricing] = useState(false);
  const [settled, setSettled] = useState<ActionRecord | null>(null);
  const [run, setRun] = useState<DeskRun>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);

  // One in-flight action per surface; both hooks stay mounted so hook order
  // never depends on the direction switch.
  const activeMint = useActiveAction("mint");
  const activeRedeem = useActiveAction("redeem");
  const active = direction === "mint" ? activeMint : activeRedeem;

  const connected = session.status === "connected";
  const walletBound = onchain.address !== null;

  const currency = currencies[currencyIdx] ?? null;
  // A stale whereIdx (mid currency switch) falls back to the first entry.
  const where =
    currency !== null ? (currency.entries[whereIdx] ?? currency.entries[0] ?? null) : null;
  const source: Source | null = (() => {
    if (currency === null || where === null) return null;
    if (where.kind === "local") return { kind: "local", asset: where.asset };
    return {
      kind: "remote",
      chainId: where.origin.chainId,
      chainLabel: where.origin.label,
      token: where.token,
    };
  })();

  // The selected asset when it is local — the mint/redeem contract's
  // counterparty, and the receive target in redeem mode (redemption pays
  // out on the deployment chain; remote chains are origins only).
  const asset = source?.kind === "local" ? source.asset : null;
  const isReserve = asset !== null && localAssets[0] !== undefined && asset.address === localAssets[0].address;
  const viaSwap = mintQuote?.viaSwap ?? false;
  // The selection's display symbol and, for bridge origins, its chain —
  // narrowed once here so the render never re-narrows the union.
  const sourceSymbol =
    source === null ? "stable" : source.kind === "local" ? source.asset.symbol : source.token.symbol;
  const remoteChainLabel = source?.kind === "remote" ? source.chainLabel : null;
  const remoteTokenSymbol = source?.kind === "remote" ? source.token.symbol : null;

  // The reserve identity — what the bridge pays out and what the mint leg
  // pulls. Fail-soft to the generic noun, like every desk on the page.
  let underlying: Address | null = null;
  try {
    underlying = getContracts().addresses.underlying as Address;
  } catch {
    underlying = null;
  }
  const reserve = reserveSymbol();
  const remoteMint = direction === "mint" && source?.kind === "remote";

  const amount = Number(amountText);
  const validAmount = Number.isFinite(amount) && amount > 0;
  const paused = mintQuote?.paused ?? false;

  const [otherBalance, setOtherBalance] = useState<number | null>(null);
  const balance = !walletBound
    ? 0
    : direction === "redeem"
      ? onchain.gUsd
      : asset === null
        ? 0
        : isReserve
          ? onchain.stable
          : (otherBalance ?? 0);
  const inputLabel = direction === "mint" ? sourceSymbol : "gUSD";
  const outputLabel = direction === "mint" ? "gUSD" : (asset?.symbol ?? "stable");

  // Reset the chain row when the currency changes — selections don't carry.
  useEffect(() => {
    setWhereIdx(0);
  }, [currencyIdx]);

  // ?demo=fund preselects a bridge-served route (dev only, mount-applied so
  // hydration agrees) so the remote leg can be walked without a mainnet
  // wallet; a no-op when no origin serves any currency.
  useEffect(() => {
    if (!DEMO_FUND) return;
    const opts = currencyOptions(localAssets, origins);
    const ci = opts.findIndex((c) => c.entries.some((e) => e.kind === "remote"));
    if (ci < 0) return;
    setCurrencyIdx(ci);
    setWhereIdx(opts[ci]?.entries.findIndex((e) => e.kind === "remote") ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Previews are async reads (contract previews here, a third-party bridge
  // API for remote origins) — debounce the keystroke, cancel on unmount,
  // never land a quote for an input that has since changed, and clear the
  // stale quote up front: during the debounce the ledger shows "—". Remote
  // quotes compose: the bridge prices origin → reserve, then the mint
  // contract previews reserve → gUSD off the bridge's expected output.
  useEffect(() => {
    setSettled(null);
    setError(null);
    // A failed lane is terminal — drop it with the stale quote so a fresh
    // input never sits under an old failure. Live lanes stay pinned.
    setRun((r) => (r.kind === "failed" ? { kind: "idle" } : r));
    setBridgeQuote(null);
    setMintQuote(null);
    if (!validAmount || source === null) return;
    if (remoteMint && !connected) return; // pricing locks to the depositor
    let alive = true;
    setPricing(true);
    const timer = setTimeout(() => {
      const done = () => {
        if (alive) setPricing(false);
      };
      if (remoteMint && source.kind === "remote") {
        bridge
          .getQuote(source.chainId, source.token.address, amount)
          .then(async (b) => {
            if (!alive) return;
            setBridgeQuote(b);
            if (b === null || underlying === null) {
              done();
              return;
            }
            try {
              const m = await mint.quote("mint", underlying, b.expectedOutput);
              if (alive) setMintQuote(m);
            } catch {
              if (alive) setMintQuote(null);
            }
            done();
          })
          .catch(done);
      } else if (asset !== null) {
        mint
          .quote(direction, asset.address, amount)
          .then((m) => {
            if (alive) setMintQuote(m);
          })
          .catch(() => {
            if (alive) setMintQuote(null);
          })
          .finally(done);
      } else {
        done();
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    bridge,
    mint,
    direction,
    amount,
    validAmount,
    connected,
    currencyIdx,
    whereIdx,
    asset?.address,
    source?.kind,
  ]);

  // Non-reserve local balances aren't in the account snapshot — one direct
  // read per selected asset (null renders "—" until it lands).
  useEffect(() => {
    setOtherBalance(null);
    if (asset === null || isReserve || !walletBound || session.address === null) return;
    let alive = true;
    contractReads()
      .balanceOf(asset.address, session.address as `0x${string}`)
      .then((raw) => {
        if (alive) setOtherBalance(formatStableRaw(raw));
      })
      .catch(() => {
        if (alive) setOtherBalance(null);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset?.address, isReserve, walletBound, session.address]);

  async function onConnect() {
    setError(null);
    try {
      await auth.connect();
    } catch {
      // A closed wallet modal is a normal exit, not an error state.
    }
  }

  async function onSubmit() {
    setError(null);
    setSettled(null);
    if (source === null) return;
    if (remoteMint && source.kind === "remote") {
      await onBridgeAndMint();
      return;
    }
    if (asset === null) return;
    try {
      const record =
        direction === "mint"
          ? await mint.mint(asset.address, amount)
          : await mint.redeem(asset.address, amount);
      setSettled(record);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The transaction didn't start.");
    }
  }

  /** The under-the-hood route: bridge origin → reserve, then mint at the
   *  quote's guaranteed floor without a second click. The floor is what
   *  execution guarantees, so the mint prefills from it — never the
   *  happy-path number. */
  async function onBridgeAndMint() {
    if (bridgeQuote === null) return;
    const quote = bridgeQuote;
    setRun({
      kind: "bridging",
      progress: { phase: "approving", message: "Starting the bridge…", txHash: null, error: null },
    });
    let minting = false;
    try {
      const outcome = await runBridgeToMint(bridge, quote, (progress) =>
        setRun({ kind: "bridging", progress }),
      );
      if (outcome.kind === "failed") {
        setRun({ kind: "failed", error: outcome.error });
        return;
      }
      if (underlying === null) {
        setRun({ kind: "failed", error: "The reserve asset is not configured — nothing to mint into." });
        return;
      }
      setRun({ kind: "minting" });
      minting = true;
      const record = await mint.mint(underlying, quote.minOutput);
      setSettled(record);
      setRun({ kind: "idle" });
    } catch (err) {
      setRun({
        kind: "failed",
        error: minting
          ? `${err instanceof Error ? err.message : "The mint didn't start"} — the landed funds sit in the wallet as ${reserve}; to mint them, switch the source to ${activeChainChip()} → ${reserve} and Mint.`
          : `The bridge didn't start — no funds moved. ${err instanceof Error ? err.message : ""}`.trim(),
      });
    }
  }

  // Composed route figures. The remote floor is the bridge's guaranteed
  // output run through the mint's real fee rate — the same math execution
  // runs, not a rounded marketing number.
  const remoteFloor =
    bridgeQuote !== null && mintQuote !== null
      ? bridgeQuote.minOutput * (1 - mintQuote.feeBps / 10_000)
      : null;
  const ready =
    direction === "mint" && source?.kind === "remote"
      ? bridgeQuote !== null && mintQuote !== null
      : mintQuote !== null;
  const busy = active !== null || run.kind === "bridging" || run.kind === "minting";

  return (
    <TuiPanel
      no="01"
      title={
        <>
          Get <Gusd />
        </>
      }
      meta={`${inputLabel} → ${outputLabel}`}
    >
      <div className="p-3.5">
        <p className="text-[11.5px] leading-relaxed text-dim">
          {direction === "mint" ? (
            source?.kind === "remote" ? (
              <>
                The bridge converts {source.token.symbol} en route — it lands here as {reserve} and mints
                1:1 into gUSD. One path, one price: approve, bridge, mint.
              </>
            ) : viaSwap ? (
              <>
                {asset !== null && stableLabel(asset)} routes through the StableRouter — one pool swap to
                the reserve asset, then the same 1:1 mint.
              </>
            ) : (
              <>
                Minting pulls {asset !== null && stableLabel(asset)} 1:1 into gUSD, net of the mint fee;
                redeeming runs the reverse.
              </>
            )
          ) : (
            <>
              Redeeming burns gUSD and pays out {asset !== null && stableLabel(asset)} net of the redeem fee
              {viaSwap ? ", after one pool swap to the token" : ""}.
            </>
          )}{" "}
          Every figure below is the execution&apos;s own preview.
        </p>
        <div className="mt-3">
          <WalletlessNote />
        </div>
      </div>

      <div className="px-3.5 pb-3.5">
        {/* What the user holds — the currency row leads, the chains that
            carry it follow. Redemption pays out on the deployment chain, so
            its currencies are the local stables. */}
        <div
          className="mb-3 flex flex-wrap gap-1.5"
          role="group"
          aria-label={direction === "mint" ? "Source currency" : "Payout currency"}
        >
          {currencies.map((c, i) => (
            <button
              key={c.symbol}
              type="button"
              aria-pressed={currencyIdx === i}
              onClick={() => setCurrencyIdx(i)}
              className={`slug border px-2 py-1.5 transition-colors ${
                currencyIdx === i
                  ? "border-rule-strong bg-raise text-bright"
                  : "border-rule text-dim hover:text-data"
              }`}
            >
              {c.symbol}
            </button>
          ))}
        </div>

        {/* The chains that carry the selected currency. One entry needs no
            row; the deployment chain reads by its own name, never "this
            chain" — bridge origins are one more chip, never a second flow. */}
        {currency !== null && currency.entries.length > 1 && (
          <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Source chain">
            {currency.entries.map((e, i) => (
              <button
                key={e.kind === "local" ? e.asset.address : e.origin.chainId}
                type="button"
                aria-pressed={whereIdx === i}
                onClick={() => setWhereIdx(i)}
                className={`slug border px-2 py-1.5 transition-colors ${
                  whereIdx === i
                    ? "border-rule-strong bg-raise text-bright"
                    : "border-rule text-dim hover:text-data"
                }`}
              >
                {e.kind === "local" ? activeChainChip() : e.origin.label}
              </button>
            ))}
          </div>
        )}

        {/* Direction */}
        <div className="grid grid-cols-2 border border-rule-strong" role="group" aria-label="Direction">
          {(["mint", "redeem"] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={direction === d}
              onClick={() => {
                setDirection(d);
                setAmountText("1000");
                // Redemption pays out on the deployment chain — a selection
                // it can't serve falls back to the first local stable.
                if (d === "redeem") {
                  setCurrencyIdx((c) =>
                    currencies[c]?.entries.some((e) => e.kind === "local") ? c : 0,
                  );
                  setWhereIdx(0);
                }
              }}
              className={`slug py-2.5 transition-colors ${
                direction === d ? (d === "mint" ? "rev-g" : "rev-d") : "text-dim hover:text-data"
              }`}
            >
              {d === "mint" ? (
                <>
                  Mint · {inputLabel} → <Gusd />
                </>
              ) : (
                <>
                  Redeem · <Gusd /> → {outputLabel}
                </>
              )}
            </button>
          ))}
        </div>

        {/* Amount */}
        <div className="mt-3.5 flex items-baseline justify-between">
          <span className="slug text-dim">
            {direction === "mint" ? "Amount" : "Redeem"} · {inputLabel}
            {source?.kind === "remote" && ` on ${source.chainLabel}`}
          </span>
          {walletBound && asset !== null && (
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
          {/* Presets need a balance — remote origins don't read from here,
              so their amount is free-typed. */}
          {asset !== null && (
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
          )}
        </div>

        {/* Quote ledger — send, the machinery as one dim route row, then the
            figures the decision hangs on. Remote floors are the two legs
            composed; the desk never prints a number execution can't honor. */}
        <dl className="mt-3.5 space-y-1.5 text-[12.5px]">
          <LedgerRow
            label={direction === "mint" ? "You send" : "You redeem"}
            value={
              validAmount
                ? `${fmtGusdLedger(amount)} ${inputLabel}${source?.kind === "remote" ? ` · ${source.chainLabel}` : ""}`
                : "—"
            }
          />
          {remoteMint && (
            <LedgerRow
              label="Route"
              value={
                bridgeQuote !== null
                  ? `bridge → ${reserve} · mint`
                  : connected
                    ? "bridge → reserve · mint"
                    : "—"
              }
            />
          )}
          {!remoteMint && direction === "mint" && viaSwap && (
            <LedgerRow label="Route" value={`swap → ${reserve} · mint`} />
          )}
          <LedgerRow
            label="Fee"
            value={
              remoteMint ? (
                bridgeQuote !== null ? (
                  `${units(bridgeQuote.originFee, remoteTokenSymbol)} bridge${mintQuote ? ` · ${(mintQuote.feeBps / 100).toFixed(2)}% mint` : ""}`
                ) : (
                  "—"
                )
              ) : mintQuote ? (
                `${fmtGusdLedger(mintQuote.fee)} ${viaSwap ? "gUSD-eq" : inputLabel}`
              ) : (
                "—"
              )
            }
          />
          <LedgerRow
            label="You receive"
            value={
              remoteMint ? (
                mintQuote !== null && bridgeQuote !== null ? (
                  `${fmtGusdLedger(mintQuote.output)} ${outputLabel}`
                ) : (
                  "—"
                )
              ) : mintQuote ? (
                `${fmtGusdLedger(mintQuote.output)} ${outputLabel}`
              ) : (
                "—"
              )
            }
            strong
          />
          {/* Floors print whenever a leg signs one in: the swap path's
              slippage clip, the bridge path's composed guarantee. The
              reserve path's preview is exact — no row. */}
          {remoteMint && remoteFloor !== null && (
            <LedgerRow label="Guaranteed floor" value={`${fmtGusdLedger(remoteFloor)} ${outputLabel}`} />
          )}
          {!remoteMint && viaSwap && mintQuote?.minOutput != null && (
            <LedgerRow label="Guaranteed floor" value={`${fmtGusdLedger(mintQuote.minOutput)} ${outputLabel}`} />
          )}
          {remoteMint && bridgeQuote !== null && (
            <LedgerRow label="Fill time" value={`~${Math.max(1, Math.round(bridgeQuote.etaSeconds / 60))} min`} />
          )}
        </dl>

        {remoteMint && bridgeQuote !== null && (
          <p className="mt-3 text-[11.5px] leading-relaxed text-dim">
            The wallet switches to {remoteChainLabel ?? "the origin chain"} for the approval and
            deposit, then back here for the mint — which runs on its own once the funds land.
          </p>
        )}

        {remoteMint && connected && !pricing && validAmount && bridgeQuote === null && (
          <p className="mt-3 text-[11.5px] leading-relaxed text-amber">
            No route priced {sourceSymbol} → {reserve} just now — the pair may
            be unroutable or the bridge briefly unavailable. Try another chain, currency, or size.
          </p>
        )}

        {remoteMint && bridgeQuote !== null && mintQuote === null && !pricing && (
          <p className="mt-3 text-[11.5px] leading-relaxed text-amber">
            The bridge priced the route; the mint leg isn&apos;t pricing right now — try again in a
            moment.
          </p>
        )}

        {remoteMint && !connected && validAmount && (
          <p className="mt-3 text-[11.5px] leading-relaxed text-dim">
            Connect a wallet to price the cross-chain route — quotes lock to the receiving address.
          </p>
        )}

        {!remoteMint && asset !== null && !isReserve && validAmount && !pricing && mintQuote === null && (
          <p className="mt-3 text-[11.5px] leading-relaxed text-amber">
            No funding pool prices {asset.symbol} ⇄ gUSD yet — LP depth has to exist before this asset
            routes.
          </p>
        )}

        {paused && (
          <p className="mt-3 text-[11.5px] leading-relaxed text-amber">
            {direction === "mint"
              ? "Minting is paused by the protocol operator — try again later."
              : "Redemption is paused by the protocol operator — try again later."}
          </p>
        )}

        {/* The bridge lane — one honest place for the machinery while it
            runs; the mint leg renders as the ordinary action record. */}
        {run.kind === "bridging" && (
          <div aria-live="polite" className="mt-3 border border-rule-strong bg-raise p-2.5">
            <p className="slug text-dim">Step 1 · Bridge</p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-data">{run.progress.message}</p>
            {run.progress.txHash && (
              <p className="num mt-1 text-[10px] text-dim" title={run.progress.txHash}>
                {fmtHash(run.progress.txHash)}
              </p>
            )}
            <p className="slug mt-2.5 text-dim">Step 2 · Mint</p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-dim">starts once the funds land</p>
          </div>
        )}
        {run.kind === "minting" && (
          <div aria-live="polite" className="mt-3 border border-rule-strong bg-raise p-2.5">
            <p className="slug text-dim">Step 1 · Bridge</p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-dim">funds landed as {reserve}.</p>
            <p className="slug mt-2.5 text-dim">Step 2 · Mint</p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-data">minting the landed reserve…</p>
          </div>
        )}
        {run.kind === "failed" && (
          <p role="alert" className="mt-3 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
            {run.error}
          </p>
        )}

        {/* The mint leg's record — local submits and the bridge flow's step
            two land here alike, as the ordinary action receipt. */}
        {(active ?? settled) && <ActionStatus record={(active ?? settled) as ActionRecord} />}

        {error && (
          <p role="alert" className="mt-3 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
            {error}
          </p>
        )}

        {/* One CTA — the connect button until a wallet exists, then the
            whole route. Local and remote stay one door. */}
        {!connected ? (
          <button
            type="button"
            onClick={onConnect}
            className="slug rev-g mt-3.5 w-full py-2.5 text-rev-fg transition-opacity hover:opacity-90"
          >
            {direction === "redeem" ? "Connect & redeem" : remoteMint ? "Connect & bridge" : "Connect & mint"}
          </button>
        ) : (
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || !validAmount || paused || !ready || source === null}
            className={`slug mt-3.5 w-full py-2.5 text-rev-fg transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${
              direction === "mint" ? "rev-g hover:opacity-90" : "border border-down text-down hover:bg-down/10"
            }`}
          >
            {busy ? (
              "Working…"
            ) : direction === "mint" ? (
              remoteMint ? (
                <>
                  Get <Gusd /> — bridge &amp; mint
                </>
              ) : (
                <>
                  Mint <Gusd />
                </>
              )
            ) : (
              <>Redeem for {outputLabel}</>
            )}
          </button>
        )}
      </div>
    </TuiPanel>
  );
}

/* ------------------------------------------------------------------ */
/* Fail-soft sources                                                   */
/* ------------------------------------------------------------------ */

/** The chain's funding stables, cheapest fail in the desk: no deployment/
 *  config → the reserve-only posture with generic copy, never a crash. */
function localStables(): StableMeta[] {
  try {
    return stablesFor();
  } catch {
    return [];
  }
}

/** Bridge-served origin chains — empty wherever the capability gate says no
 *  (testnets, unknown chains, dev builds without the funding flag). */
function remoteOrigins(bridge: { origins(): BridgeOrigin[] }): BridgeOrigin[] {
  try {
    const caps = chainCapabilities(getActiveChain().id);
    if (caps === null || !caps.crossChainFunding) return [];
    return bridge.origins();
  } catch {
    return [];
  }
}

/** The deployment chain's own name — the desk names chains ("Robinhood",
 *  "Ethereum"), it never says "this chain". Registry label minus its status
 *  suffix; fail-soft to the product's primary chain, same as every identity
 *  read here. */
function activeChainChip(): string {
  try {
    return chainLabel(getActiveChain().id)?.split("·")[0]?.trim() || "Robinhood Chain";
  } catch {
    return "Robinhood Chain";
  }
}

/** The reserve asset's display symbol — the same fail-soft accessor the
 *  system bar uses; an unconfigured chain renders the generic noun. */
function reserveSymbol(): string {
  try {
    return stableConfig().underlying.symbol;
  } catch {
    return "the reserve";
  }
}

/** A ledger amount with its unit — no trailing space when the symbol is absent. */
function units(value: number, symbol: string | null | undefined): string {
  return symbol ? `${fmtGusdLedger(value)} ${symbol}` : fmtGusdLedger(value);
}
