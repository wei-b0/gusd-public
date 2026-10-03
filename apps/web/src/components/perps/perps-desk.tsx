"use client";

/**
 * PerpsDesk — the perpetuals desk: analyse, arm, and settle a leveraged
 * gUSD-settled GPU perpetual in one dense composition — the spot desk's
 * sibling, visibly more capable than a form stack. The plate is the room's
 * center of gravity: the benchmark's candlesticks with the mark strip above
 * them (mark, 24h, funding, open interest) and every position, order, and
 * trigger reading against that mark. The bands beneath carry the market's
 * risk schedule, the position board, armed orders, triggers, and the
 * liquidations tape. There is no order book in this protocol (the engine
 * fills at oracle reports) — none is simulated; the armed-orders board and
 * the tape carry the flow record.
 *
 * Architecture note: orders are two-stage. The desk arms them (the engine
 * locks collateral + the keeper's execution fee) and the keeper executes
 * against a fresh oracle report later — so nothing here pins a report into
 * the submit. Quotes price at the current attestation with the same
 * debounce doctrine the spot slip runs; the position/orders/claim probes
 * are verify-only (they never consume a report) on a lazy interval, not on
 * every tick. Leveraged exposure only — outright trading lives on the spot
 * desk (`/spot/[asset]`), the sibling composition.
 */

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import type { ActionRecord } from "@/domain/actions";
import type {
  AssetId,
  ChartRange,
  PerpCloseQuote,
  PerpMarketState,
  PerpOpenQuote,
  PerpOrderKind,
  PerpPendingOrder,
  PerpPositionProbe,
  PerpPositionState,
  PerpSide,
} from "@/domain/types";
import { carryMark, positionOf } from "@/data/web3/perps/portfolio-book";
import { CHART_RANGES, marketMove24h, pairName } from "@/domain/types";
import { Pair } from "@/components/ui/pair";
import { ActionStatus } from "@/components/ui/action-status";
import { WalletlessNote } from "@/components/ui/walletless-note";
import { TabBar } from "@/components/ui/tab-bar";
import { TickFlash } from "@/components/ui/tick-flash";
import { TuiPanel } from "@/components/ui/panel";
import { TvPriceChart } from "@/components/charts/tv-price-chart";
import {
  useAccount,
  useActiveAction,
  useMarketSnapshot,
  useMarkets,
  useServices,
  useWalletSession,
} from "@/data/services";
import {
  fmtAge,
  fmtClock,
  fmtGusdCompact,
  fmtGusdLedger,
  fmtGusdPrecise,
  fmtPctSigned,
  fmtSignedGusd,
  fmtUnitsMax,
  fmtUsdPrecise,
  isFlatPct,
} from "@/domain/format";
import { DEFAULT_TOLERANCE_BPS, TOLERANCE_PRESETS_BPS } from "@/data/web3/trading/quotes";
import { triggerMet } from "@/data/web3/perps/triggers";
import { ORACLE_PANELS } from "@/data/oracle/panel-map";
import { usePerpMarketStates } from "@/data/web3/perps/use-perp-markets";
import {
  fetchIndexedPerpLiquidations,
  type IndexedPerpLiquidation,
} from "@/data/web3/perps/indexed";

const QUOTE_DEBOUNCE_MS = 250;
const QUOTE_RETRY_MS = 1_500;
/** Verified probes are read-backed (no report consumption); a lazy poll
 *  keeps the panels honest without hammering the RPC. */
const POLL_MS = 15_000;
/** The liquidations tape is public record — a lazier poll than the book. */
const TAPE_POLL_MS = 60_000;

const RANGES = CHART_RANGES;
const TABS = ["Overview", "Chart", "Trade", "Activity"] as const;

const KIND_LABEL: Record<PerpOrderKind, string> = {
  open: "OPEN",
  close: "CLOSE",
  "stop-loss": "SL",
  "take-profit": "TP",
};

/** Price floats → the engine's 4-dec raw (for trigger sanity hints). */
function priceRaw(price: number): bigint {
  return BigInt(Math.round(price * 10_000));
}

/** Funding ppm/second → the per-day figure the desk speaks. Shared with the
 *  board and rail via ./funding-voices. */
import { fundingCashVoice, fundingShort, fundingVoice, num, perDay } from "./funding-voices";

/* ------------------------------------------------------------------ */
/* desk shell                                                          */
/* ------------------------------------------------------------------ */

export function PerpsDesk({ asset }: { asset: AssetId }) {
  const { perp } = useServices();
  const session = useWalletSession();
  const markets = useMarkets();
  const account = useAccount();
  const connected = session.status === "connected";

  const [range, setRange] = useState<ChartRange>("1h");
  const [tab, setTab] = useState<string>("Overview");
  const snapshot = useMarketSnapshot(asset, range);

  // All four markets' onchain state in one shared probe — the rail's
  // funding figures and this desk's risk schedule read the same source.
  const states = usePerpMarketStates();
  const market = states[asset];

  const [book, setBook] = useState<{
    long: PerpPositionProbe;
    short: PerpPositionProbe;
    orders: PerpPendingOrder[] | null;
    claimable: number | null;
    // The claim gate — any open position on ANY market (claimable is
    // wallet-global). null = unreadable, which blocks too.
    anyOpen: boolean | null;
  }>({
    long: { kind: "unknown" },
    short: { kind: "unknown" },
    orders: null,
    claimable: null,
    anyOpen: null,
  });
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((k) => k + 1);
  // Flips after the first book read resolves, so panel 07 can tell
  // "still reading" from "the read failed".
  const [bookLoaded, setBookLoaded] = useState(false);

  // The book the desk renders from: position probes on both sides (raw
  // figures always; marked figures only when a current report priced the
  // read), pending orders, and the claimable counter — refreshed lazily.
  // Without a wallet the whole loop stays silent. A probe whose raw read
  // failed (`unknown`) never overwrites the last known state — an open
  // position must not vanish because one poll dropped.
  useEffect(() => {
    if (!connected) {
      setBook({
        long: { kind: "flat" },
        short: { kind: "flat" },
        orders: null,
        claimable: null,
        anyOpen: null,
      });
      setBookLoaded(false);
      return;
    }
    let alive = true;
    const load = () => {
      Promise.all([
        perp.getPosition(asset, "long").catch((): PerpPositionProbe => ({ kind: "unknown" })),
        perp.getPosition(asset, "short").catch((): PerpPositionProbe => ({ kind: "unknown" })),
        perp.listPendingOrders().catch(() => null),
        perp.getClaimable().catch(() => null),
        perp.hasOpenPosition().catch(() => null),
      ]).then(([long, short, pending, claim, anyOpen]) => {
        if (!alive) return;
        setBookLoaded(true);
        setBook((prev) => ({
          long: long.kind === "unknown" ? prev.long : carryMark(long, prev.long),
          short: short.kind === "unknown" ? prev.short : carryMark(short, prev.short),
          // null = the read failed — the orders panel says so, never an
          // honest-sounding "nothing armed".
          orders: pending,
          claimable: claim,
          anyOpen,
        }));
      });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [perp, asset, connected, refreshKey]);

  // The mark: the venue price when a market layer exists, otherwise the
  // API's Index — the benchmark reference every desk stands on. Per-row
  // figures mark at the probe's verified report price instead (T0-4).
  const row = markets.find((m) => m.asset.id === asset);
  const mark = row?.marketPrice ?? row?.indexPrice ?? null;

  if (!snapshot) return null;
  const m = snapshot.market;

  const vis = (name: string) => `${tab === name ? "" : "hidden"} lg:block`;
  // Grid items hide at the item level so hidden tracks create no rows or gaps.
  const cellVis = (names: string[]) =>
    (names.includes(tab) ? "" : "hidden") + " lg:block";

  // Equity of this market's positions — summed only where a report has
  // actually marked a side; all-unmarked reads as "—", never a masked zero.
  const equity = (() => {
    const a = positionOf(book.long);
    const b = positionOf(book.short);
    if (a?.equity == null && b?.equity == null) return null;
    return (a?.equity ?? 0) + (b?.equity ?? 0);
  })();

  // Panel 07's read state: a failed read is distinct from an empty list —
  // it never renders as "nothing armed".
  const ordersState: "reading" | "live" | "failed" =
    !bookLoaded ? "reading" : book.orders === null ? "failed" : "live";

  return (
    <div>
      {/* Mobile task switcher — desktop stays spatial */}
      <div className="mb-5 lg:hidden">
        <TabBar tabs={TABS.map((id) => ({ id, label: id }))} active={tab} onChange={setTab} label="Perp desk sections" />
      </div>

      <div className="grid gap-5 lg:grid-cols-[230px_minmax(0,1fr)_310px]">
        {/* Left rail — the perp markets, the session's account, the hardware.
            Same tiling as the spot rail: the markets frame grows to the row's
            height so the rail bottoms out with the plate and trade rail. */}
        <div
          className={`order-4 space-y-5 lg:order-1 lg:flex lg:flex-col ${tab === "Overview" ? "" : "hidden"
            } lg:block`}
        >
          <div className="lg:grow">
            <TuiPanel no="01" title="Perp markets" meta="gUSD-settled" className="lg:flex lg:h-full lg:flex-col">
              <div className="lg:flex-1">
                {markets.map((mk) => {
                  const active = mk.asset.id === asset;
                  const mkMark = mk.marketPrice ?? mk.indexPrice;
                  const move = marketMove24h(mk);
                  const flat = isFlatPct(move);
                  const st = states[mk.asset.id];
                  return (
                    <Link
                      key={mk.asset.id}
                      href={`/perps/${mk.asset.id}`}
                      aria-current={active ? "page" : undefined}
                      className={`block w-full border-b border-rule px-3 py-2 text-left transition-colors last:border-b-0 ${active ? "bg-panel-deep" : "hover:bg-panel-deep"
                        }`}
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="flex items-baseline gap-1.5">
                          <span
                            aria-hidden
                            className={`text-[9px] ${active ? "text-amber" : "text-transparent"}`}
                          >
                            ▶
                          </span>
                          <span
                            className={`num text-[13px] font-bold whitespace-nowrap ${active ? "text-bright" : "text-data"
                              }`}
                          >
                            {pairName(mk.asset.id)}
                          </span>
                        </span>
                        {mkMark === null || mkMark === undefined ? (
                          <span className="num text-[11px] text-dim">—</span>
                        ) : (
                          <TickFlash
                            value={mkMark}
                            precision={4}
                            className="num inline-block text-[11px] font-bold text-wire"
                          >
                            {fmtUsdPrecise(mkMark)}
                          </TickFlash>
                        )}
                      </span>
                      <span className="mt-0.5 flex items-baseline justify-between gap-2">
                        <span
                          className={`num text-[10.5px] ${move === null || flat ? "text-dim" : move >= 0 ? "text-up" : "text-down"}`}
                        >
                          {move === null ? "—" : fmtPctSigned(move)}
                        </span>
                        <span className="num text-[10.5px] text-dim">
                          {st == null ? "—" : `fund ${fundingShort(st.fundingRateLongPpmPerSec)}`}
                        </span>
                      </span>
                    </Link>
                  );
                })}
              </div>
              <p className="border-t border-rule px-3.5 py-2.5 text-[10.5px] leading-relaxed text-dim">
                Trade {pairName(asset)} outright on the{" "}
                <Link
                  href={`/spot/${asset}`}
                  className="text-data underline decoration-rule-strong underline-offset-2 hover:text-bright"
                >
                  spot desk
                </Link>{" "}
                — same benchmark, no leverage.
              </p>
            </TuiPanel>
          </div>

          <div>
            <AccountPanel
              no="02"
              asset={asset}
              account={account}
              connected={connected}
              equity={equity}
              claimable={book.claimable}
              anyOpen={book.anyOpen}
              onRefresh={bump}
            />
          </div>
        </div>

        {/* Center — the plate. The panel is a flex column that fills the
            grid row (same tiling doctrine as the spot plate): the candle
            chart is its flex-1 body and the row's height is the tallest
            column's, so the plate bottoms out with both rails instead of
            freezing at a vh height. */}
        <div className={`order-1 min-w-0 lg:order-2 ${cellVis(["Chart"])}`}>
          <div className="flex h-full flex-col">
            <TuiPanel
              no="03"
              className="flex h-full flex-col"
              bodyClassName="flex min-h-0 flex-1 flex-col"
              title={
                <>
                  <Pair id={asset} /> perp
                </>
              }
              meta={`${range} candles · UTC`}
              right={
                <div role="group" aria-label="Chart interval" className="flex items-center">
                  {RANGES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      aria-pressed={range === r}
                      onClick={() => setRange(r)}
                      className={`num border-b px-2.5 py-1 text-[11px] transition-colors ${range === r
                        ? "border-amber text-amber"
                        : "border-transparent text-dim hover:text-data"
                        }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              }
            >
              {/* The benchmark strip — the series reference: a market figure, bright
                  phosphor, with the / GPU-hour unit named. Fills settle at the
                  verified report price, which marks each position row. */}
              <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2 border-b border-rule px-3.5 py-2.5">
                <span className="inline-flex items-baseline gap-1.5">
                  {mark === null ? (
                    <span className="disp text-[26px] leading-none text-dim">—</span>
                  ) : (
                    <TickFlash
                      value={mark}
                      precision={4}
                      arrow="hold"
                      className="disp text-[26px] leading-none text-bright"
                    >
                      {fmtUsdPrecise(mark)}
                    </TickFlash>
                  )}
                  <span className="num text-[11px] text-dim">/ GPU-hour</span>
                </span>
                {(() => {
                  const move = row ? marketMove24h(row) : null;
                  const flat = isFlatPct(move);
                  return move === null ? null : (
                    <span
                      className={`num inline-flex items-baseline gap-1 text-[12px] ${flat ? "text-dim" : move >= 0 ? "text-up" : "text-down"
                        }`}
                    >
                      <TickFlash value={move} precision={2} className="inline-block">
                        {fmtPctSigned(move)}
                      </TickFlash>
                      {flat ? null : (
                        <span aria-hidden className="text-[9px]">{move >= 0 ? "▲" : "▼"}</span>
                      )}{" "}
                      · 24h
                    </span>
                  );
                })()}
                {market != null && (
                  <span className="num text-[11.5px] text-dim">
                    Funding{" "}
                    <span className="text-data">
                      {fundingVoice(market.fundingRateLongPpmPerSec)} ln ·{" "}
                      {fundingVoice(market.fundingRateShortPpmPerSec)} sh
                    </span>{" "}
                    /day
                  </span>
                )}
                {market != null && (
                  <span className="num text-[11.5px] text-dim">
                    OI{" "}
                    <span className="text-data">
                      {fmtGusdCompact(market.openInterestLong + market.openInterestShort)}
                    </span>{" "}
                    / {fmtGusdCompact(market.maxOiUsd)} gUSD
                  </span>
                )}
              </div>
              <div className="min-h-0 flex-1 p-2 pr-3">
                <TvPriceChart
                  asset={asset}
                  range={range}
                  className="h-full min-h-96 lg:min-h-95"
                />
              </div>
              <div className="border-t border-rule px-3.5 py-2">
                <p className="slug text-dim">
                  Benchmark series · reference prices — fills settle at the verified report price
                </p>
              </div>
            </TuiPanel>
          </div>
        </div>

        {/* Right rail — the trade. Same tiling as the spot trade rail: the
            frame grows to the row's height, slack living inside the panel. */}
        <div className={`order-2 space-y-5 lg:order-3 lg:flex lg:flex-col ${cellVis(["Trade"])}`}>
          <div className={vis("Trade")}>
            <TuiPanel
              no="04"
              title="Order slip"
              meta="orders arm · fills settle at verified reports"
              className="lg:flex lg:h-full lg:flex-col"
            >
              <div className="lg:flex-1">
                <OrderSlip
                  asset={asset}
                  market={market}
                  mark={mark}
                  connected={connected}
                  balance={account.gUsdBalance}
                  positions={book}
                  onSettled={bump}
                />
              </div>
            </TuiPanel>
          </div>
        </div>

        {/* Row two — the risk schedule, spanning the full width. The order
            utilities keep the mobile stack (rail 4, plate 1, right rail 2)
            ahead of the bands on every task. */}
        <div className={`order-6 lg:order-4 lg:col-span-3 ${cellVis(["Overview"])}`}>
          <Statistics market={market} stats={snapshot.stats} />
        </div>

        {/* Full-width depth — the position book and its record */}
        <div className={`order-7 lg:order-5 lg:col-span-3 ${cellVis(["Trade"])}`}>
          <PositionsBand
            asset={asset}
            positions={book}
            connected={connected}
            onRefresh={bump}
          />
        </div>
        <div className={`order-8 lg:order-6 lg:col-span-3 ${cellVis(["Trade"])}`}>
          <OrdersPanel orders={book.orders} ordersState={ordersState} connected={connected} onRefresh={bump} />
        </div>
        <div className={`order-9 lg:order-7 lg:col-span-3 ${cellVis(["Trade"])}`}>
          <TriggerPanel asset={asset} positions={book} connected={connected} mark={mark} onSettled={bump} />
        </div>
        <div className={`order-10 lg:order-8 lg:col-span-3 ${cellVis(["Activity"])}`}>
          <LiquidationsBand asset={asset} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 02 — account (balance · equity · claimable)                         */
/* ------------------------------------------------------------------ */

function AccountPanel({
  no,
  asset,
  account,
  connected,
  equity,
  claimable,
  anyOpen,
  onRefresh,
}: {
  no: string;
  asset: AssetId;
  account: ReturnType<typeof useAccount>;
  connected: boolean;
  equity: number | null;
  claimable: number | null;
  anyOpen: boolean | null;
  onRefresh: () => void;
}) {
  const { perp } = useServices();
  const active = useActiveAction("perp-claim");
  const [settled, setSettled] = useState<ActionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The gate: claimable is wallet-global, so one open position anywhere
  // holds it — and an unreadable book (anyOpen null) blocks too: claim
  // never fires off an unreadable position state.
  const claimBlocked = anyOpen !== false;
  const claimableReady = claimable !== null && claimable > 0;
  const canClaim = active === null && claimableReady && !claimBlocked;

  async function claim() {
    if (active !== null || claimable === null || claimable <= 0 || claimBlocked) return;
    setError(null);
    try {
      const record = await perp.claim(claimable);
      setSettled(record);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The claim didn't go through. Try again in a moment.");
    }
  }

  return (
    <TuiPanel no={no} title="Account"
      meta={connected ? account.label ?? undefined : "not connected"}
    >
      {connected ? (
        <div className="space-y-1.5 p-3.5">
          <Row label="gUSD balance" value={fmtGusdLedger(account.gUsdBalance)} />
          <Row
            label={`Position equity · ${pairName(asset)}`}
            value={equity === null ? "—" : `${fmtGusdLedger(equity)} gUSD`}
          />
          <div className="flex items-baseline justify-between gap-3 border-b border-rule pb-1.5">
            <dt className="slug text-dim">Claimable</dt>
            <dd className="flex items-baseline gap-2">
              <span className="num text-[12px] text-bright">
                {claimable === null ? "—" : fmtGusdLedger(claimable)}
              </span>
              <button
                type="button"
                onClick={claim}
                disabled={!canClaim}
                className="slug border border-rule-strong px-2.5 py-0.5 text-dim transition-colors hover:text-amber disabled:cursor-not-allowed disabled:opacity-40"
              >
                {active !== null ? "Claiming…" : "Claim"}
              </button>
            </dd>
          </div>
          {claimableReady && claimBlocked ? (
            <p className="pt-1 text-[10.5px] leading-relaxed text-dim">
              {anyOpen === null
                ? "Can't read your positions right now — the Claim button waits until the reads come back."
                : "One or more positions are open — close them to free the claimable balance for payout."}
            </p>
          ) : null}
          {settled && <ActionStatus record={settled} />}
          {error && (
            <p className="border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
              {error}
            </p>
          )}
          <p className="pt-1 text-[10.5px] leading-relaxed text-dim">
            Closes and triggers first settle into your claimable balance; Claim pays it out of the
            sgUSD earning balance — a short claim leaves the remainder. Claimable settles from
            close and liquidation proceeds only — earned funding accrues into the position itself
            and pays out when it closes. Full holdings on{" "}
            <Link href="/portfolio" className="text-data underline decoration-rule-strong underline-offset-2 hover:text-bright">
              Portfolio
            </Link>
            .
          </p>
        </div>
      ) : (
        <p className="p-3.5 text-[11.5px] leading-relaxed text-dim">
          Connect from the system bar to trade this desk.
        </p>
      )}
    </TuiPanel>
  );
}

/* ------------------------------------------------------------------ */
/* 04 — order slip (open / close)                                      */
/* ------------------------------------------------------------------ */

type PositionBook = {
  long: PerpPositionProbe;
  short: PerpPositionProbe;
  orders: PerpPendingOrder[] | null;
  claimable: number | null;
};

/** A probe's position and the mark-age carry live in the portfolio book's
 *  pure layer — the desk and the portfolio share one implementation so a
 *  live row reads identically on both surfaces. */

function OrderSlip({
  asset,
  market,
  mark,
  connected,
  balance,
  positions,
  onSettled,
}: {
  asset: AssetId;
  market: PerpMarketState | null | undefined;
  mark: number | null;
  connected: boolean;
  balance: number;
  positions: PositionBook;
  onSettled: () => void;
}) {
  const { perp } = useServices();
  const [mode, setMode] = useState<"open" | "close">("open");
  const [side, setSide] = useState<PerpSide>("long");
  const [collText, setCollText] = useState("");
  const [leverage, setLeverage] = useState(2);
  const [toleranceBps, setToleranceBps] = useState<number>(DEFAULT_TOLERANCE_BPS);
  const [closePct, setClosePct] = useState(100);
  const [quote, setQuote] = useState<PerpOpenQuote | PerpCloseQuote | null | undefined>(undefined);
  const [settled, setSettled] = useState<ActionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeOpen = useActiveAction("perp-open");
  const activeClose = useActiveAction("perp-close");
  const active = mode === "open" ? activeOpen : activeClose;

  const position = positionOf(positions[side]);
  const coll = Number(collText);
  const validInput = mode === "open" ? Number.isFinite(coll) && coll > 0 : position !== null;

  // Reset the receipt and any stale refusal when the shape of the request
  // changes — the settled record stays in the store's history.
  useEffect(() => {
    setSettled((s) => (s ? null : s));
    setError(null);
  }, [mode, side, collText, leverage, toleranceBps, closePct, position?.sizeUsd]);

  const maxLeverage = market === null || market === undefined ? 10 : market.maxLeverageBps / 10_000;
  const levPresets = [1, 2, 5, 10, 20].filter((l) => l <= maxLeverage);
  const effLeverage = Math.min(leverage, maxLeverage);
  const closeSize =
    mode === "close" && position !== null ? Math.floor(position.sizeUsd * (closePct / 100) * 1e6) / 1e6 : null;

  // The execution quote re-prices on every settled input and after an
  // action lands (the balances and position state behind it moved).
  // undefined marks the in-flight window; null after one patient retry is
  // the refusal voice — never retried away a second time.
  useEffect(() => {
    if (!validInput || mark === null) {
      setQuote(undefined);
      return;
    }
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setQuote(undefined);
    const timer = setTimeout(() => {
      const attempt = (retry: boolean) => {
        const p =
          mode === "open"
            ? perp.quoteOpen({ asset, side, collateral: coll, leverage: effLeverage, toleranceBps })
            : perp.quoteClose({ asset, side, size: closeSize, toleranceBps });
        p.then((q) => {
          if (!alive) return;
          if (q === null && retry) {
            retryTimer = setTimeout(() => attempt(false), QUOTE_RETRY_MS);
            return;
          }
          setQuote(q);
        }).catch(() => {
          if (alive) setQuote(null);
        });
      };
      attempt(true);
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
      clearTimeout(retryTimer);
    };
  }, [perp, asset, mode, side, coll, effLeverage, toleranceBps, validInput, mark, closeSize, position?.sizeUsd]);

  // The open side's local pre-flight — the same checks the engine runs,
  // spoken in place before the chain even quotes (quoteOpen answers null
  // for all of them; the desk can name which one).
  const openGate: string | null =
    market === undefined
      ? null // still checking — dashes, not a refusal
      : market === null
        ? "No perp market exists for this asset yet — markets open when the protocol registers them."
        : !market.enabled
          ? "This perp market is disabled by the protocol right now."
          : validInput && coll < market.minCollateralUsd
            ? `That collateral is under this market's minimum of ${fmtGusdLedger(market.minCollateralUsd)} gUSD — raise the amount.`
            : validInput && coll > balance
              ? "The wallet's gUSD balance is too low for this order — check the amount."
              : validInput && (sizeOf(coll, effLeverage) > market.maxPositionUsd || openInterestOver(market, side, coll, effLeverage))
                ? "That order exceeds this market's caps — size down (per-position and open-interest limits print on the market strip)."
                : null;

  const gate: string | null =
    mode === "open"
      ? openGate
      : positions[side].kind === "unknown"
        ? "Can't read this position right now — try again in a moment."
        : position === null
          ? "There's no position on this side to close — it may have settled already."
          : null;

  const quoteRefused = gate === null && validInput && mark !== null && quote === null;
  const quoteGate: string | null = !quoteRefused
    ? null
    : mode === "open"
      ? "This order doesn't fit the market's rules — check the minimum collateral, leverage cap, and open-interest room."
      : "Nothing to quote this close against — the position may have settled already.";

  async function onSubmit() {
    if (!connected) {
      setError("Connect a wallet to trade perps — nothing signs without one.");
      return;
    }
    if (!validInput) {
      setError(mode === "open" ? "Enter a gUSD collateral amount greater than zero." : "There's no position to close.");
      return;
    }
    if (gate || quoteGate || quote === null || quote === undefined) return;
    setError(null);
    try {
      const record =
        mode === "open"
          ? await perp.open({ asset, side, collateral: coll, leverage: effLeverage, toleranceBps })
          : await perp.close({ asset, side, size: closePct === 100 ? null : closeSize, toleranceBps });
      setSettled(record);
      onSettled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The order didn't go through. Try again in a moment.");
    }
  }

  const longActive = side === "long";

  return (
    <div className="space-y-3 p-3.5">
      {/* side */}
      <div className="grid grid-cols-2 gap-px border border-rule-strong bg-rule-strong">
        <button
          type="button"
          onClick={() => setSide("long")}
          className={`slug py-2 transition-colors ${longActive ? "rev-g text-rev-fg" : "bg-panel text-dim hover:text-data"}`}
        >
          ▲ LONG
        </button>
        <button
          type="button"
          onClick={() => setSide("short")}
          className={`slug py-2 transition-colors ${!longActive ? "rev-d text-rev-fg" : "bg-panel text-dim hover:text-data"}`}
        >
          ▼ SHORT
        </button>
      </div>

      {mode === "open" ? (
        <>
          {/* collateral */}
          <div>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <label htmlFor="perp-coll" className="slug text-[10px] text-dim">
                COLLATERAL · gUSD
              </label>
              {connected && (
                <button
                  type="button"
                  onClick={() => setCollText(fmtUnitsMax(balance))}
                  className="slug text-[10px] text-dim transition-colors hover:text-amber"
                >
                  balance {fmtGusdLedger(balance)} · MAX
                </button>
              )}
            </div>
            <input
              id="perp-coll"
              value={collText}
              onChange={(e) => setCollText(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              spellCheck={false}
              className="num w-full border border-rule-strong bg-transparent px-3 py-2.5 text-[15px] text-data outline-none focus-within:border-amber"
            />
          </div>
          {/* leverage */}
          <div>
            <p className="slug mb-1 text-[10px] text-dim">LEVERAGE · ≤ {num(maxLeverage)}×</p>
            <div className="flex flex-wrap gap-px border border-rule-strong bg-rule-strong">
              {levPresets.map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLeverage(l)}
                  className={`num flex-1 py-1.5 text-[12px] transition-colors ${
                    effLeverage === l ? "rev" : "bg-panel text-dim hover:text-data"
                  }`}
                >
                  {l}×
                </button>
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          {/* close fraction */}
          <div>
            <p className="slug mb-1 text-[10px] text-dim">
              CLOSE · {position === null ? "no position" : `${fmtGusdLedger(position.sizeUsd)} notional held`}
            </p>
            <div className="flex flex-wrap gap-px border border-rule-strong bg-rule-strong">
              {[25, 50, 75, 100].map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setClosePct(p)}
                  className={`num flex-1 py-1.5 text-[12px] transition-colors ${
                    closePct === p ? "rev" : "bg-panel text-dim hover:text-data"
                  }`}
                >
                  {p}%
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* slippage — the price limit the armed order refuses to fill past */}
      <div>
        <p className="slug mb-1 text-[10px] text-dim">
          SLIPPAGE · {mode === "open" ? (longActive ? "fills below" : "fills above") : longActive ? "closes above" : "closes below"} the limit
        </p>
        <div className="flex flex-wrap gap-px border border-rule-strong bg-rule-strong">
          {TOLERANCE_PRESETS_BPS.map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setToleranceBps(b)}
              className={`num flex-1 py-1.5 text-[12px] transition-colors ${
                toleranceBps === b ? "rev" : "bg-panel text-dim hover:text-data"
              }`}
            >
              {num(b / 100)}%
            </button>
          ))}
        </div>
      </div>

      {/* ledger */}
      <dl className="border-t border-rule">
        {mode === "open" ? (
          isQuote(quote) ? (
            <>
              <Row label="Collateral in" value={`${fmtGusdLedger(quote.collateral)} gUSD`} />
              <Row label="Position size" value={`${fmtGusdLedger(quote.sizeUsd)} gUSD`} strong />
              <Row label="Collateral in" value={`${fmtGusdLedger(quote.collateral)} gUSD`} />
              <Row label="Position size" value={`${fmtGusdLedger(quote.sizeUsd)} gUSD`} strong />
              <Row label="Est. Fees" value={`${fmtGusdLedger(quote.openFee + quote.executionFee)} gUSD`} />
              <Row
                label="Est. liquidation price"
                value={quote.estLiquidationPrice === null ? "—" : fmtGusdPrecise(quote.estLiquidationPrice)}
              />
            </>
          ) : (
            <Row label="Position size" value="—" strong />
          )
        ) : isCloseQuote(quote) ? (
          <>
            <Row label="Closing" value={`${fmtGusdLedger(quote.sizeUsd)} gUSD of ${fmtGusdPrecise(quote.entryPrice)} entry`} />
            <Row
              label="PnL at settlement price"
              value={`${fmtSignedGusd(quote.pnl)} gUSD`}
              strong
              className={quote.pnl >= 0 ? "text-up" : "text-down"}
            />
            <Row label="Est. Fees" value={`${fmtGusdLedger(quote.closeFee + quote.executionFee)} gUSD`} />
            <Row
              label="Funding net"
              value={fundingCashVoice(quote.fundingNet)}
              className={quote.fundingNet <= 0 ? "text-up" : "text-down"}
            />
            <Row
              label="Est. liquidation price"
              value={quote.estLiquidationPrice === null ? "—" : fmtGusdPrecise(quote.estLiquidationPrice)}
            />
            <Row
              label="Settles to claimable"
              value={`${fmtGusdLedger(quote.proceeds)} gUSD`}
              strong
            />
          </>
        ) : (
          <Row label="Settles to claimable" value="—" strong />
        )}
      </dl>

      {isCloseQuote(quote) && quote.shortfall > 0 && (
        <p className="border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
          Funding and fees eat this close by {fmtGusdLedger(quote.shortfall)} gUSD — nothing settles
          to claimable.
        </p>
      )}

      {market === undefined && (
        <p className="text-[11.5px] leading-relaxed text-dim">Checking the market onchain…</p>
      )}
      {mark === null && (
        <p className="text-[11.5px] leading-relaxed text-dim">
          No reference price yet — orders open when the feed asserts one.
        </p>
      )}
      {quote === undefined && gate === null && validInput && mark !== null && (
        <p className="text-[11.5px] leading-relaxed text-dim">Quoting against the current report…</p>
      )}

      <WalletlessNote />

      {gate && (
        <p className="border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">{gate}</p>
      )}
      {quoteGate && (
        <p className="border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
          {quoteGate}
        </p>
      )}
      {!connected && (
        <p className="text-[11.5px] leading-relaxed text-dim">
          Connect a wallet to trade — nothing signs without one.
        </p>
      )}
      {error && (
        <p className="border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">{error}</p>
      )}

      {(active ?? settled) && <ActionStatus record={(active ?? settled) as ActionRecord} />}

      <button
        type="button"
        onClick={onSubmit}
        disabled={active !== null || !validInput || quote === null || quote === undefined || gate !== null || quoteGate !== null || mark === null}
        className={`slug w-full py-2.5 text-rev-fg transition-opacity disabled:cursor-not-allowed disabled:opacity-40 hover:opacity-90 ${
          longActive ? "rev-g" : "rev-d"
        }`}
      >
        {active !== null ? (
          "Arming…"
        ) : (
          <>
            {mode === "open" ? "Open" : "Close"} {longActive ? "long" : "short"} <Pair id={asset} />
          </>
        )}
      </button>
      <p className="slug text-[10px] text-dim">
        Arming locks {mode === "open" ? "collateral and" : ""} the execution fee — the order stays
        armed until it fills or you cancel it.
      </p>
    </div>
  );
}

function sizeOf(coll: number, leverage: number): number {
  return coll * leverage;
}

function openInterestOver(market: PerpMarketState, side: PerpSide, coll: number, leverage: number): boolean {
  const size = sizeOf(coll, leverage);
  const sideOi = side === "long" ? market.openInterestLong : market.openInterestShort;
  return sideOi + size > market.maxOiUsd;
}

/** Runtime narrowing — the open and close quote shapes share no fields the
 *  ledger needs to disambiguate on. */
function isQuote(
  q: PerpOpenQuote | PerpCloseQuote | null | undefined,
): q is PerpOpenQuote {
  return q !== null && q !== undefined && "openFee" in q;
}

function isCloseQuote(
  q: PerpOpenQuote | PerpCloseQuote | null | undefined,
): q is PerpCloseQuote {
  return q !== null && q !== undefined && "proceeds" in q;
}

/* ------------------------------------------------------------------ */
/* 05 — market statistics · the risk schedule                          */
/* ------------------------------------------------------------------ */

/**
 * Statistics — the desk's widest band, tiled into listing-board cells.
 * The window stats come from the benchmark series (the chart's own data);
 * the risk schedule is the market's onchain state — the figures a levered
 * position lives under. "—" until the chain asserts each one.
 */
function Statistics({
  market,
  stats,
}: {
  market: PerpMarketState | null | undefined;
  stats: {
    high24h: number | null;
    low24h: number | null;
    high30d: number | null;
    low30d: number | null;
    open24h: number | null;
  };
}) {
  const price = (n: number | null) => (n === null ? "—" : fmtUsdPrecise(n));
  const cells: { label: string; value: string }[] = [
    { label: "Open 24h", value: price(stats.open24h) },
    { label: "High 24h", value: price(stats.high24h) },
    { label: "Low 24h", value: price(stats.low24h) },
    { label: "30d high", value: price(stats.high30d) },
    { label: "30d low", value: price(stats.low30d) },
    {
      label: "Funding · longs",
      value: market == null ? "—" : `${fundingVoice(market.fundingRateLongPpmPerSec)} /day`,
    },
    {
      label: "Funding · shorts",
      value: market == null ? "—" : `${fundingVoice(market.fundingRateShortPpmPerSec)} /day`,
    },
    { label: "Borrow", value: market == null ? "—" : `${perDay(market.borrowRatePpmPerSec)} /day` },
    { label: "Leverage cap", value: market == null ? "—" : `${num(market.maxLeverageBps / 10_000)}×` },
    { label: "Maintenance margin", value: market == null ? "—" : `${num(market.maintenanceMarginBps / 100)}%` },
    { label: "Open fee", value: market == null ? "—" : `${num(market.openFeeBps / 100)}%` },
    { label: "Close fee", value: market == null ? "—" : `${num(market.closeFeeBps / 100)}%` },
    { label: "Liquidation fee", value: market == null ? "—" : `${num(market.liquidationFeeBps / 100)}%` },
    { label: "Min collateral", value: market == null ? "—" : `${fmtGusdLedger(market.minCollateralUsd)} gUSD` },
    { label: "Open interest long", value: market == null ? "—" : `${fmtGusdCompact(market.openInterestLong)} gUSD` },
    { label: "Open interest short", value: market == null ? "—" : `${fmtGusdCompact(market.openInterestShort)} gUSD` },
    { label: "Max position", value: market == null ? "—" : `${fmtGusdCompact(market.maxPositionUsd)} gUSD` },
    { label: "Max open interest", value: market == null ? "—" : `${fmtGusdCompact(market.maxOiUsd)} gUSD` },
  ];
  return (
    <TuiPanel no="05" title="Market statistics" meta="risk schedule · benchmark window">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-0 p-3.5 md:grid-cols-4 lg:grid-cols-8">
        {cells.map((cell) => (
          <div
            key={cell.label}
            className="flex items-baseline justify-between gap-2 border-b border-rule py-2"
          >
            <dt className="slug text-dim">{cell.label}</dt>
            <dd className="num text-[12.5px] font-bold text-data">{cell.value}</dd>
          </div>
        ))}
      </dl>
      {market === null && (
        <p className="px-3.5 pb-3.5 text-[11.5px] leading-relaxed text-dim">
          No perp market registered onchain yet — the risk schedule asserts when the protocol opens one.
        </p>
      )}
    </TuiPanel>
  );
}

/* ------------------------------------------------------------------ */
/* 06 — the position board                                             */
/* ------------------------------------------------------------------ */

/**
 * PositionsBand — the session's open positions as one dense board. Every
 * row marks at the probe's verified report price — the price the engine
 * itself evaluates the liquidation gate at — never at the strip's
 * benchmark reference. The liquidation distance is the risk figure: how
 * far the mark sits from the forced-close line, amber inside ten percent.
 * A report gap never hides a position: rows fall back to raw onchain
 * figures with the marking voice.
 */
function PositionsBand({
  asset,
  positions,
  connected,
  onRefresh,
}: {
  asset: AssetId;
  positions: PositionBook;
  connected: boolean;
  onRefresh: () => void;
}) {
  const { perp } = useServices();
  const closeActive = useActiveAction("perp-close") !== null;
  const [settled, setSettled] = useState<ActionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sides = (["long", "short"] as const).filter((s) => positionOf(positions[s]) !== null);
  const anyPosition = sides.length > 0;
  // A probe whose raw read failed keeps the desk reading — existence is
  // unresolved, never rendered as "Flat".
  const reading =
    !anyPosition && (positions.long.kind === "unknown" || positions.short.kind === "unknown");
  // The first live position carries the mark-age footnote.
  const firstSide = sides[0];
  const firstPosition = firstSide === undefined ? null : positionOf(positions[firstSide]);

  async function marketClose(side: PerpSide) {
    if (closeActive) return;
    setError(null);
    try {
      const record = await perp.close({ asset, side, size: null });
      setSettled(record);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The close didn't arm. Try again in a moment.");
    }
  }

  return (
    <TuiPanel
      no="06"
      title="Positions"
      meta={connected ? (anyPosition ? `${sides.length} open` : reading ? "reading…" : "flat") : undefined}
    >
      {!connected && (
        <p className="px-3.5 py-3 text-[11.5px] leading-relaxed text-dim">
          Connect a wallet to hold perp positions.
        </p>
      )}
      {connected && !anyPosition && reading && (
        <p className="px-3.5 py-3 text-[11.5px] leading-relaxed text-dim">
          Reading the book…
        </p>
      )}
      {connected && !anyPosition && !reading && (
        <p className="px-3.5 py-3 text-[11.5px] leading-relaxed text-dim">
          Flat — no position on this market. Arm an open from the trade rail.
        </p>
      )}
      {anyPosition && (
        <div className="relative">
          <div className="overflow-x-auto">
            <table className="w-full table-auto border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-rule text-left">
                  <th scope="col" className="slug py-2 pl-3.5 pr-3 text-dim">Side</th>
                  <th scope="col" className="slug px-2.5 py-2 text-right text-dim">
                    Notional <span className="tracking-normal normal-case">/ gUSD</span>
                  </th>
                  <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Collateral</th>
                  <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Entry</th>
                  <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Mark</th>
                  <th scope="col" className="slug px-2.5 py-2 text-right text-dim">uPnL</th>
                  <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Equity</th>
                  <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Funding net</th>
                  <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Est. liq</th>
                  <th scope="col" className="slug px-2.5 py-2 text-right text-dim">Distance</th>
                  <th scope="col" className="slug py-2 pl-2.5 pr-3.5 text-right text-dim">
                    <span className="sr-only">Close</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sides.map((side) => {
                  const p = positionOf(positions[side]);
                  if (p === null) return null;
                  return (
                    <PositionRow
                      key={side}
                      state={p}
                      closeActive={closeActive}
                      onClose={() => marketClose(side)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* Advertise the horizontal swipe where the table clips */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-[linear-gradient(to_left,var(--color-ground),transparent)] lg:hidden"
          />
        </div>
      )}
      {sides.map((side) => {
        const p = positionOf(positions[side]);
        if (p === null || p.liquidatable !== true) return null;
        return (
          <p
            key={side}
            className="mx-3.5 mt-3 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber"
          >
            {side === "long" ? "Long" : "Short"} position at the liquidation threshold — the next report past maintenance
            lets anyone liquidate. Close now; the position does not recover on its own.
          </p>
        );
      })}
      {anyPosition && firstPosition && (
        <p className="px-3.5 pb-3.5 pt-2 slug text-[10px] text-dim">
          {firstPosition.markPrice !== null && firstPosition.markedAt !== null
            ? `Rows mark at the verified report price (${fmtAge(firstPosition.markedAt, Date.now())} old) — accrued funding settles at the next onchain touch.`
            : firstPosition.markedAt !== null
              ? `Marking unavailable right now — rows show raw onchain figures; last verified ${fmtAge(firstPosition.markedAt, Date.now())}.`
              : "Marking unavailable right now — rows show raw onchain figures until a verified price report prices them."}
        </p>
      )}
      {settled && (
        <div className="px-3.5 pb-3.5">
          <ActionStatus record={settled} />
        </div>
      )}
      {error && (
        <p className="mx-3.5 mb-3.5 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
          {error}
        </p>
      )}
    </TuiPanel>
  );
}

function PositionRow({
  state,
  closeActive,
  onClose,
}: {
  state: PerpPositionState;
  closeActive: boolean;
  onClose: () => void;
}) {
  const long = state.side === "long";
  const liqDist =
    state.liquidationPrice !== null && state.markPrice !== null && state.markPrice > 0
      ? Math.abs((state.liquidationPrice - state.markPrice) / state.markPrice) * 100
      : null;
  const nearLiq = liqDist !== null && liqDist <= 10;
  // Negative equity is real debt — shown signed and down-toned, amber once
  // it sits under the maintenance floor.
  const underWater =
    state.equity !== null && state.maintenance !== null && state.equity < state.maintenance;
  return (
    <tr className="border-b border-rule transition-colors last:border-b-0 hover:bg-panel-deep">
      <td className={`slug py-2 pl-3.5 pr-3 ${long ? "text-up" : "text-down"}`}>
        <span aria-hidden className="mr-1 text-[8px]">{long ? "▲" : "▼"}</span>
        {long ? "LONG" : "SHORT"}
      </td>
      <td className="num px-2.5 py-2 text-right font-bold text-bright">{fmtGusdLedger(state.sizeUsd)}</td>
      <td className="num px-2.5 py-2 text-right text-data">{fmtGusdLedger(state.collateral)}</td>
      <td className="num px-2.5 py-2 text-right text-data">{fmtGusdPrecise(state.entryPrice)}</td>
      <td className="num px-2.5 py-2 text-right text-data">
        {state.markPrice === null ? "—" : fmtGusdPrecise(state.markPrice)}
      </td>
      <td className={`num px-2.5 py-2 text-right font-bold ${state.uPnl === null ? "text-dim" : state.uPnl >= 0 ? "text-up" : "text-down"}`}>
        {state.uPnl === null ? "—" : fmtSignedGusd(state.uPnl)}
      </td>
      <td className={`num px-2.5 py-2 text-right ${state.equity === null ? "text-dim" : underWater ? "text-amber" : state.equity < 0 ? "text-down" : "text-data"}`}>
        {state.equity === null ? "—" : fmtSignedGusd(state.equity)}
      </td>
      <td className={`num px-2.5 py-2 text-right ${state.fundingNet === null ? "text-dim" : state.fundingNet <= 0 ? "text-up" : "text-down"}`}>
        {state.fundingNet === null
          ? "—"
          : state.fundingNet === 0
            ? "0.0000"
            : `${fmtSignedGusd(-state.fundingNet)} ${state.fundingNet < 0 ? "received" : "paid"}`}
      </td>
      <td className="num px-2.5 py-2 text-right text-data">
        {state.liquidationPrice === null ? "—" : fmtGusdPrecise(state.liquidationPrice)}
      </td>
      <td className={`num px-2.5 py-2 text-right font-bold ${nearLiq ? "text-amber" : "text-data"}`}>
        {liqDist === null ? "—" : `${num(liqDist)}%`}
      </td>
      <td className="py-2 pl-2.5 pr-3.5 text-right">
        <button
          type="button"
          onClick={onClose}
          disabled={closeActive}
          className="slug border border-rule-strong px-2.5 py-0.5 text-dim transition-colors hover:text-bright disabled:cursor-not-allowed disabled:opacity-40"
        >
          {closeActive ? "closing…" : "Close"}
        </button>
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------ */
/* 07 — armed orders                                                   */
/* ------------------------------------------------------------------ */

/**
 * OrdersPanel — the session's armed orders. An armed order locks its
 * collateral and the execution fee up front, then waits for the venue:
 * it stays armed until it fills or you cancel it — no expiry. An open
 * whose price bound has already printed simply waits for the next
 * settlement price inside its bound.
 */
function OrdersPanel({
  orders,
  ordersState,
  connected,
  onRefresh,
}: {
  orders: PerpPendingOrder[] | null;
  ordersState: "reading" | "live" | "failed";
  connected: boolean;
  onRefresh: () => void;
}) {
  const { perp } = useServices();
  const active = useActiveAction("perp-cancel");
  const [settled, setSettled] = useState<ActionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function cancel(orderId: number) {
    if (active !== null) return;
    setError(null);
    try {
      const record = await perp.cancelOrder(orderId);
      setSettled(record);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The cancel didn't go through. Try again in a moment.");
    }
  }

  return (
    <TuiPanel
      no="07"
      title="Armed orders"
      meta={ordersState === "live" ? `${orders?.length ?? 0} pending` : undefined}
    >
      <div className="px-3.5 pb-1 pt-2.5 text-[11.5px] leading-relaxed text-dim">
        Orders lock their collateral and the execution fee up front, then fill at the next settlement price inside
        their limit — they stay armed until they fill or you cancel them.
      </div>
      {!connected ? (
        <p className="px-3.5 pb-3.5 text-[11.5px] leading-relaxed text-dim">Connect a wallet to see your orders.</p>
      ) : ordersState === "reading" ? (
        <p className="px-3.5 pb-3.5 text-[11.5px] leading-relaxed text-dim">Reading orders…</p>
      ) : ordersState === "failed" ? (
        <div className="flex items-center justify-between gap-3 px-3.5 pb-3.5">
          <p className="text-[11.5px] leading-relaxed text-amber">
            Couldn't read your armed orders — the book read failed. Your orders are unaffected.
          </p>
          <button
            type="button"
            onClick={onRefresh}
            className="slug shrink-0 border border-rule-strong px-2.5 py-0.5 text-dim transition-colors hover:text-bright"
          >
            Retry
          </button>
        </div>
      ) : orders === null || orders.length === 0 ? (
        <p className="px-3.5 pb-3.5 text-[11.5px] leading-relaxed text-dim">Nothing armed.</p>
      ) : (
        <ul className="border-t border-rule">
          {orders.map((o) => (
            <li
              key={o.orderId}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule px-3.5 py-2 last:border-b-0"
            >
              <span className="num text-[11px] text-data">
                <span className="font-bold text-amber">#{o.orderId}</span>{" "}
                <span className={o.side === "long" ? "text-up" : "text-down"}>{KIND_LABEL[o.kind]}</span>{" "}
                {o.kind === "open" ? (
                  <>
                    {fmtGusdLedger(o.sizeUsd)} @ limit {fmtGusdPrecise(o.price)} · locked {fmtGusdLedger(o.collateral)}{" "}
                    gUSD
                  </>
                ) : o.kind === "close" ? (
                  <>
                    close {fmtGusdLedger(o.sizeUsd)} @ limit {fmtGusdPrecise(o.price)}
                  </>
                ) : (
                  <>
                    {o.sizeUsd === 0 ? "whole position" : `close ${fmtGusdLedger(o.sizeUsd)}`} {o.side} @ trigger{" "}
                    {fmtGusdPrecise(o.price)}
                  </>
                )}
              </span>
              <span className="flex items-baseline gap-3">
                <span className="slug text-[10px] text-dim">armed {fmtAge(o.createdAt, Date.now())}</span>
                <button
                  type="button"
                  onClick={() => cancel(o.orderId)}
                  disabled={active !== null}
                  className="slug border border-rule-strong px-2.5 py-0.5 text-dim transition-colors hover:text-bright disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {active !== null ? "…" : "Cancel"}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {settled && (
        <div className="px-3.5 pb-3.5">
          <ActionStatus record={settled} />
        </div>
      )}
      {error && (
        <p className="mx-3.5 mb-3.5 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
          {error}
        </p>
      )}
    </TuiPanel>
  );
}

/* ------------------------------------------------------------------ */
/* 08 — TP/SL triggers                                                 */
/* ------------------------------------------------------------------ */

function TriggerPanel({
  asset,
  positions,
  connected,
  mark,
  onSettled,
}: {
  asset: AssetId;
  positions: PositionBook;
  connected: boolean;
  mark: number | null;
  onSettled: () => void;
}) {
  const sides = (["long", "short"] as const).filter((s) => positionOf(positions[s]) !== null);
  if (!connected || sides.length === 0) {
    return (
      <TuiPanel no="08" title="Stop-loss · take-profit" meta="armed per position">
        <p className="px-3.5 py-3 text-[11.5px] leading-relaxed text-dim">
          {connected
            ? "Arm a trigger from here once a position is open."
            : "Connect a wallet to arm triggers."}
        </p>
      </TuiPanel>
    );
  }
  return (
    <TuiPanel no="08" title="Stop-loss · take-profit" meta="armed per position">
      {sides.map((side) => (
        <TriggerForm
          key={side}
          asset={asset}
          side={side}
          mark={positionOf(positions[side])?.markPrice ?? mark}
          onSettled={onSettled}
        />
      ))}
    </TuiPanel>
  );
}

function TriggerForm({
  asset,
  side,
  mark,
  onSettled,
}: {
  asset: AssetId;
  side: PerpSide;
  mark: number | null;
  onSettled: () => void;
}) {
  const { perp } = useServices();
  const [kind, setKind] = useState<"stop-loss" | "take-profit">("stop-loss");
  const [triggerText, setTriggerText] = useState("");
  const [settled, setSettled] = useState<ActionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useActiveAction("perp-trigger");

  const trigger = Number(triggerText);
  const valid = Number.isFinite(trigger) && trigger > 0;

  // A trigger past the mark on the firing side prints at the next
  // verified report — not a refusal (a stop-loss has no price floor by
  // design), just a hint before it fills.
  const wrongSideHint =
    valid && mark !== null
      ? triggerMet(kind, side === "long", priceRaw(trigger), priceRaw(mark))
        ? "That trigger has already printed against the mark — it fills at the next verified report."
        : null
      : null;

  // A trigger set far from the mark is usually a typo — warn, don't block.
  const farHint =
    valid && mark !== null && mark > 0 && Math.abs(trigger - mark) / mark > 0.5
      ? `That trigger sits ${num(Math.abs(((trigger - mark) / mark) * 100))}% ${trigger > mark ? "above" : "below"} the mark — check it before arming.`
      : null;

  useEffect(() => {
    setSettled((s) => (s ? null : s));
    setError(null);
  }, [kind, triggerText]);

  async function arm() {
    if (active !== null || !valid) return;
    setError(null);
    try {
      const record = await perp.armTrigger({ asset, side, kind, triggerPrice: trigger, size: null });
      setSettled(record);
      onSettled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The trigger didn't arm. Try again in a moment.");
    }
  }

  const long = side === "long";
  const dirHint =
    kind === "take-profit"
      ? long
        ? "fires when mark ≥ trigger"
        : "fires when mark ≤ trigger"
      : long
        ? "fires when mark ≤ trigger"
        : "fires when mark ≥ trigger";

  return (
    <div className="border-b border-rule px-3.5 py-3 last:border-b-0">
      <p className="num mb-2 text-[12px] font-bold text-data">
        <span className={long ? "text-up" : "text-down"}>{long ? "▲ LONG" : "▼ SHORT"}</span> position
      </p>
      <div className="mb-2 flex flex-wrap gap-px border border-rule-strong bg-rule-strong">
        {(["stop-loss", "take-profit"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`slug flex-1 py-1.5 transition-colors ${kind === k ? "rev" : "bg-panel text-dim hover:text-data"}`}
          >
            {k === "stop-loss" ? "STOP-LOSS" : "TAKE-PROFIT"}
          </button>
        ))}
      </div>
      <input
        value={triggerText}
        onChange={(e) => setTriggerText(e.target.value)}
        inputMode="decimal"
        placeholder="trigger price · USD / GPU-hour"
        spellCheck={false}
        aria-label={`Trigger price for the ${side} position`}
        className="num w-full border border-rule-strong bg-transparent px-3 py-2.5 text-[15px] text-data outline-none focus-within:border-amber"
      />
      <p className="slug mt-1.5 text-[10px] text-dim">
        {dirHint} · {mark === null ? "no mark yet" : `mark ${fmtGusdPrecise(mark)}`} · replaces any armed{" "}
        {kind === "stop-loss" ? "stop-loss" : "take-profit"} on this position
      </p>
      {wrongSideHint && (
        <p className="mt-2 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
          {wrongSideHint}
        </p>
      )}
      {farHint && (
        <p className="mt-2 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
          {farHint}
        </p>
      )}
      {kind === "stop-loss" && (
        <p className="mt-2 slug text-[10px] leading-relaxed text-dim">
          A stop-loss fills at the settlement price — it has no price floor. In a fast move the fill can land past the
          trigger.
        </p>
      )}
      {error && (
        <p className="mt-2 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
          {error}
        </p>
      )}
      {settled && (
        <div className="mt-2">
          <ActionStatus record={settled} />
        </div>
      )}
      <button
        type="button"
        onClick={arm}
        disabled={active !== null || !valid}
        className="slug rev-g w-full py-2 text-rev-fg transition-opacity disabled:cursor-not-allowed disabled:opacity-40 hover:opacity-90"
      >
        {active !== null ? "Arming…" : `Arm ${kind === "stop-loss" ? "stop-loss" : "take-profit"}`}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 09 — liquidations tape                                              */
/* ------------------------------------------------------------------ */

/**
 * LiquidationsBand — the public record of forced closes the keeper (or
 * anyone) printed against past reports, as the indexer projected it. The
 * indexer absent → the band renders nothing (no indexer, no tape); the
 * tape present but empty is the honest empty — nothing has liquidated.
 */
function LiquidationsBand({ asset }: { asset: AssetId }) {
  const [rows, setRows] = useState<readonly IndexedPerpLiquidation[] | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const gpuId = ORACLE_PANELS[asset]?.gpuId;
    const load = () => {
      fetchIndexedPerpLiquidations(gpuId).then((r) => {
        if (alive) setRows(r);
      });
    };
    load();
    const timer = setInterval(load, TAPE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [asset]);

  // The indexer absent — the band keeps the desk's rhythm but prints nothing.
  if (rows === null) return null;

  return (
    <TuiPanel no="09" title="Liquidations" meta="public record · newest first">
      {rows === undefined ? (
        <p className="px-3.5 py-3 text-[11.5px] leading-relaxed text-dim">Reading the tape…</p>
      ) : rows.length === 0 ? (
        <p className="px-3.5 py-3 text-[11.5px] leading-relaxed text-dim">
          Nothing liquidated yet on this market — forced closes print here when one executes.
        </p>
      ) : (
        <ul className="border-t border-rule">
          {rows.map((liq, i) => (
            <li
              key={`${liq.account}-${liq.blockTimestamp}-${i}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-rule px-3.5 py-1.5 last:border-b-0"
            >
              <span className="num w-20 shrink-0 whitespace-nowrap text-[11px] text-dim">
                {fmtClock(liq.blockTimestamp * 1000)} <span className="text-[9px]">UTC</span>
              </span>
              <span className={`slug w-16 shrink-0 ${liq.side === "long" ? "text-down" : "text-up"}`}>
                <span aria-hidden className="mr-1 text-[8px]">{liq.side === "long" ? "▼" : "▲"}</span>
                {liq.side === "long" ? "LONG" : "SHORT"}
              </span>
              <span className="num flex-1 whitespace-nowrap text-right text-[12px] text-data">
                forced close @ {fmtGusdPrecise(liq.execPrice)}
              </span>
              <span className="num w-28 shrink-0 text-right text-[11px] text-dim">
                fee {fmtGusdLedger(liq.liquidationFee)}
                {liq.badDebt > 0 ? ` · bad debt ${fmtGusdLedger(liq.badDebt)}` : ""} gUSD
              </span>
              <span className="num w-24 shrink-0 text-right text-[10.5px] text-dim">
                {liq.account.slice(0, 6)}…{liq.account.slice(-4)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </TuiPanel>
  );
}

/* ------------------------------------------------------------------ */
/* shared bits                                                         */
/* ------------------------------------------------------------------ */

function Row({
  label,
  value,
  strong,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  strong?: boolean;
  className?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-rule py-2 last:border-b-0">
      <dt className="slug text-[10.5px] text-dim">{label}</dt>
      <dd className={`num text-[12px] whitespace-nowrap ${strong ? "font-bold text-bright" : "text-data"} ${className ?? ""}`}>
        {value}
      </dd>
    </div>
  );
}