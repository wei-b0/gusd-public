/**
 * Pure mappers from /v1/protocol wire DTOs to product vocabulary. ALL
 * decimal math lives here: the wire speaks raw-unit decimal strings
 * (gUSD 6-dec, GPU 18-dec), the product speaks JS numbers via domain/units.
 *
 * Doctrine, enforced by what these functions choose NOT to produce:
 *   - the published oracle value is never mapped to a display number
 *     (oraclePublicationRow exposes health fields only — never `price`);
 *   - `ammPriceGusd` (AMM execution state) is never consumed — depth comes
 *     from `liquidity` directly and stays a depth figure, not a price;
 *   - the executed trade price exists only in tape rows.
 */

import type { AssetId, MarketTrade } from "@/domain/types";
import { formatGpuUnits, formatGusdRaw } from "@/domain/units";
import { assetForGpuId } from "@/data/web3/gpu-id";
import type { ExecutionDto, OracleStateDto, PoolDto, PoolStatsBucketDto, SgusdVaultDto, SwapTapeDto, WalletPositionDto, WalletVaultPositionDto } from "./dto";
import type { IndexedEvent } from "@/domain/indexer";

// --- swap tape → MarketTrade --------------------------------------------------

/** One AMM swap → one tape row (price notion 4, confined to the tape).
 *  Null when the pool's currency ordering is unknown (side null), when the
 *  gUSD-side delta is unknown, or when the GPU-side delta is zero. The id
 *  is `pool:block:log` — the tape DTO carries no tx hash by design (a
 *  router Buy prints one row here AND one execution row; the execution has
 *  the hash). */
export function swapToMarketTrade(swap: SwapTapeDto, pool: PoolDto | undefined): MarketTrade | null {
  if (swap.side === null || swap.gusdAmount === null || pool === undefined) return null;
  // The GPU-side delta is signed (a swapper receiving GPU reports negative);
  // the row carries its absolute size. Malformed values skip the row.
  const gpuRawStr = pool.gusdIsCurrency0 ? swap.amount1 : swap.amount0;
  const gpuRaw = signedRaw(gpuRawStr);
  const gusdRaw = rawOf(swap.gusdAmount);
  if (gpuRaw === null || gpuRaw === 0n || gusdRaw === null) return null;
  const notional = formatGusdRaw(gusdRaw);
  const size = formatGpuUnits(gpuRaw < 0n ? -gpuRaw : gpuRaw);
  if (size === 0) return null;
  return {
    id: `${swap.poolId}:${swap.blockNumber}:${swap.logIndex}`,
    side: swap.side,
    size,
    price: notional / size,
    notional,
    t: swap.blockTimestampSec * 1000,
  };
}

// --- liquidity (in-range gUSD-side virtual reserve) ------------------------------

/** In-range gUSD-side depth of one pool: the virtual reserve implied by
 *  (liquidity, sqrtPriceX96). A depth figure for the stats strip — never a
 *  price, never conflated with a benchmark or oracle value. Null when the
 *  pool's ordering is unknown or liquidity is zero. */
export function inRangeGusdDepth(pool: PoolDto): number | null {
  if (pool.gusdIsCurrency0 === null) return null;
  const L = rawOf(pool.liquidity);
  const s = rawOf(pool.sqrtPriceX96);
  if (L === null || s === null || s === 0n || L === 0n) return null;
  const gUsdRaw = pool.gusdIsCurrency0 ? (L * (1n << 96n)) / s : (L * s) / (1n << 96n);
  return Number(gUsdRaw) / 1e6;
}

// --- 24h bucket windows -------------------------------------------------------------

const DAY_SEC = 86_400;

/** 24h volume across hourly buckets: Σ gUSD-side volume for buckets whose
 *  start is at or after nowSec − 86400. Malformed volume counts as 0. */
export function volume24hGusd(buckets: readonly PoolStatsBucketDto[], nowSec: number): number {
  return sumBuckets(buckets, nowSec, (b) => number6(b.volumeGusd) ?? 0);
}

/** 24h swap count: Σ (buys + sells) over the same window. */
export function trades24h(buckets: readonly PoolStatsBucketDto[], nowSec: number): number {
  return sumBuckets(buckets, nowSec, (b) => b.buys + b.sells);
}

function sumBuckets(
  buckets: readonly PoolStatsBucketDto[],
  nowSec: number,
  pick: (b: PoolStatsBucketDto) => number,
): number {
  const from = nowSec - DAY_SEC;
  let sum = 0;
  for (const b of buckets) {
    if (b.bucketStart >= from) sum += pick(b);
  }
  return sum;
}

// --- cost basis ------------------------------------------------------------------

/** gUSD 6-dec raw string → product number, or null untouched (the indexer
 *  nulls gated fields with a `reason`; "—" beats precise wrong math).
 *  Public: the account store parses the reads seam's basis strings with it. */
export function basisNumber(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const v = rawOf(raw);
  return v === null ? null : formatGusdRaw(v);
}

export interface BasisFields {
  /** gUSD per whole GPU (or per whole sgUSD share) — null unless complete. */
  avgEntry: number | null;
  /** Raw-gUSD realized PnL — null unless complete. */
  realizedPnl: number | null;
  /** The indexer's gate reason, verbatim, for the "—" tooltip. */
  basisReason: string | null;
}

/** Cost basis fields of one GPU position. */
export function basisFromPosition(p: WalletPositionDto): BasisFields {
  return {
    avgEntry: basisNumber(p.avgEntryGusd),
    realizedPnl: basisNumber(p.realizedPnlGusd),
    basisReason: p.reason,
  };
}

/** Cost basis fields of the vault (sgUSD) position. */
export function basisFromVault(v: WalletVaultPositionDto): BasisFields {
  return {
    avgEntry: basisNumber(v.avgEntryAssets),
    realizedPnl: basisNumber(v.realizedPnlGusd),
    basisReason: v.reason,
  };
}

// --- vault aggregates -----------------------------------------------------------------

/** gUSD currently deployed by the vault: seed + net deposits + revenue
 *  accrued to it. Null when any wire figure is malformed — never a guess. */
export function vaultDeployedGusd(v: SgusdVaultDto): number | null {
  try {
    const total =
      BigInt(v.seededGusd) + BigInt(v.depositsGusd) - BigInt(v.withdrawsGusd) + BigInt(v.revenueGusd);
    return Number(total) / 1e6;
  } catch {
    return null;
  }
}

/** sGUSD supply from the vault's ledger: minted shares − burned shares.
 *  Shares are 6-dec — same grain as the gUSD asset (ERC4626 with a zero
 *  decimals offset), NOT 18-dec. */
export function sgusdSupply(v: SgusdVaultDto): number | null {
  try {
    return Number(BigInt(v.sharesMinted) - BigInt(v.sharesBurned)) / 1e6;
  } catch {
    return null;
  }
}

/** Raw 6-dec gUSD string → display number, guarded. */
export function gusdNumber(raw: string | null): number | null {
  return number6(raw);
}

// --- activity rows --------------------------------------------------------------------

/** One display row in the merged wallet activity trail. Both sources
 *  normalize into this; executions carry legs and win dedupe. */
export interface ActivityRow {
  /** Stable key: `${source}:${chainId}:${blockNumber}:${logIndex}`. */
  id: string;
  /** Chain settlement time (epoch ms). */
  t: number;
  /** Product verb: Buy / Sell / Mint / Redeem / Issue / Stake / Unstake. */
  verb: string;
  asset: AssetId | null;
  /** GPU units when the row carries GPU (18-dec → number). */
  size: number | null;
  /** gUSD notional when the row carries gUSD (6-dec → number). */
  notional: number | null;
  source: "execution" | "event";
  txHash: string;
  blockNumber: number;
  logIndex: number;
}

/** A routed execution (GpuRouter.Buy/Sell) → activity row with legs. */
export function executionRow(x: ExecutionDto): ActivityRow {
  return {
    id: `x:${x.chainId}:${x.blockNumber}:${x.logIndex}`,
    t: x.blockTimestampSec * 1000,
    verb: x.side === "buy" ? "Buy" : "Sell",
    asset: assetForGpuId(x.gpuId as `0x${string}`),
    size: number18(x.gpuAmount),
    notional: number6(x.gUsdAmount),
    source: "execution",
    txHash: x.txHash,
    blockNumber: x.blockNumber,
    logIndex: x.logIndex,
  };
}

/** An indexed wallet event → activity row. Amount extraction uses each
 *  event's real arg names (never a generic "amount" guess):
 *    Minted → gusdOut (1e6) · Redeemed → underlyingOut (1e6)
 *    Issued → amount (1e18) · Deposit/Withdraw → assets (1e6)
 *    Buy/Sell → gpuOut/gpuIn (1e18) + paid/out (1e6)
 *  Unrecognized names or missing args leave the figures null rather than
 *  printing a wrong number. */
export function eventRow(e: IndexedEvent): ActivityRow {
  const asset = typeof e.data.gpuId === "string" ? assetForGpuId(e.data.gpuId as `0x${string}`) : null;
  switch (e.event) {
    case "Minted":
      return row(e, "Mint", asset, null, number6FromData(e, "gusdOut"));
    case "Redeemed":
      return row(e, "Redeem", asset, null, number6FromData(e, "underlyingOut"));
    case "Issued":
      return row(e, "Issue", asset, number18FromData(e, "amount"), null);
    case "Deposit":
      return row(e, "Stake", null, null, number6FromData(e, "assets"));
    case "Withdraw":
      return row(e, "Unstake", null, null, number6FromData(e, "assets"));
    case "Buy":
      return row(e, "Buy", asset, number18FromData(e, "gpuOut"), number6FromData(e, "paid"));
    case "Sell":
      return row(e, "Sell", asset, number18FromData(e, "gpuIn"), number6FromData(e, "out"));
    default:
      return row(e, e.event, asset, null, null);
  }
}

/**
 * Merge the wallet's routed executions and indexed events into one trail,
 * newest first. Buy/Sell events whose tx already has an execution row are
 * dropped (the execution wins — it carries the leg breakdown), so a router
 * trade prints once, not twice.
 */
export function mergeActivity(
  executions: readonly ExecutionDto[],
  events: readonly IndexedEvent[],
  limit: number,
): ActivityRow[] {
  const execRows = executions.map(executionRow);
  const execTx = new Set(execRows.map((r) => r.txHash.toLowerCase()));
  const rows: ActivityRow[] = [];
  for (const e of events) {
    if ((e.event === "Buy" || e.event === "Sell") && execTx.has(e.txHash.toLowerCase())) continue;
    rows.push(eventRow(e));
  }
  rows.push(...execRows);
  rows.sort((a, b) => b.t - a.t || b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
  return rows.slice(0, Math.max(0, limit));
}

function row(
  e: IndexedEvent,
  verb: string,
  asset: AssetId | null,
  size: number | null,
  notional: number | null,
): ActivityRow {
  return {
    id: `e:${e.chainId}:${e.blockNumber}:${e.logIndex}`,
    t: e.seenAtMs,
    verb,
    asset,
    size,
    notional,
    source: "event",
    txHash: e.txHash,
    blockNumber: e.blockNumber,
    logIndex: e.logIndex,
  };
}

// --- oracle publication transparency row -------------------------------------------------

/** Health fields of the indexed oracle publication, for the terminal Index
 *  feed's transparency row. The published `price` itself is deliberately
 *  NOT here — it must never render next to (or instead of) a market price. */
export interface OraclePublicationRow {
  staleness: "fresh" | "stale" | "unknown";
  /** Age at read time, recomputed from updatedAtSec — the API's ageSec is a
   *  serving-time snapshot that goes stale in the browser. */
  ageSec: number | null;
  updatedAtSec: number | null;
  lastPublishedBlockNumber: number | null;
  overridden: boolean;
}

export function oraclePublicationRow(
  state: OracleStateDto | null | undefined,
  nowSec: number | null,
): OraclePublicationRow {
  if (state === null || state === undefined) {
    return { staleness: "unknown", ageSec: null, updatedAtSec: null, lastPublishedBlockNumber: null, overridden: false };
  }
  // A null nowSec (the pre-mount clock) leaves the age null — the row
  // prints "—" for it, never a stale guess.
  const ageSec =
    state.updatedAtSec === null || nowSec === null
      ? null
      : Math.max(0, nowSec - state.updatedAtSec);
  return {
    staleness: state.staleness,
    ageSec,
    updatedAtSec: state.updatedAtSec,
    lastPublishedBlockNumber: state.lastPublishedBlockNumber,
    overridden: state.overriddenPrice !== null,
  };
}

// --- guarded raw parsing -------------------------------------------------------------------

/** A decimal raw-unit string from the wire → bigint, or null when absent
 *  or unparseable (null propagates as "—", never as zero). */
function rawOf(v: string | null | undefined): bigint | null {
  if (v === null || v === undefined || v === "") return null;
  try {
    const b = BigInt(v);
    return b < 0n ? null : b;
  } catch {
    return null;
  }
}

/** Like rawOf but for signed deltas: keeps the sign so callers can take the
 *  absolute value themselves. */
function signedRaw(v: string | null | undefined): bigint | null {
  if (v === null || v === undefined || v === "") return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

function number6(raw: string | null): number | null {
  const b = rawOf(raw);
  return b === null ? null : formatGusdRaw(b);
}

function number18(raw: string | null): number | null {
  const b = rawOf(raw);
  return b === null ? null : formatGpuUnits(b);
}

/** A decoded event arg (string raw units) → 6-dec number, or null. */
function number6FromData(e: IndexedEvent, key: string): number | null {
  const v = e.data[key];
  return typeof v === "string" ? number6(v) : null;
}

/** A decoded event arg (string raw units) → 18-dec number, or null. */
function number18FromData(e: IndexedEvent, key: string): number | null {
  const v = e.data[key];
  return typeof v === "string" ? number18(v) : null;
}
