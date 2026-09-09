/**
 * Trade quotes — the execution stack the order slip signs against. Every
 * request names its basis: size-first (`units`) or money-first (`gusd`).
 *
 * Size-first buys are exact-out through `router.buy`: one composed hook
 * swap filling the native CL book, then POL inventory, then the issuance
 * backstop, refunding the spend cap. Money-first buys are exact-in through
 * `router.buyExactIn` (pool-only): they spend exactly the typed gUSD —
 * nothing is refunded — and are bounded by the `minSize` units floor
 * instead of a spend cap. Sells are always exact-in through `router.sell`
 * (native + POL bid — no synthetic redemption); money-first sells derive
 * the units from the proceeds-first quote and execute under the payout
 * floor. On a pool-less market a money-first buy inverts the typed spend
 * against the contract's own quoteIssue (see ./genesis) and rides the
 * exact-out path under the typed-spend cap.
 *
 * All of it quotes through the float-seeded GpuQuoter, which runs the
 * pool's real hook inside an eth_call — the same pricing path execution
 * runs — and the signed limits (`maxPaid` / `minOut` / `minSize`) bound
 * the fill. Neither quote pre-commits it: state can move between eth_call
 * and inclusion, so execution is bounded by the signed limits, not the
 * quote.
 *
 * Honesty rules the math keeps: the quoter already runs the hook, so its
 * number IS all-in — protocol fees are split out for display only, and LP
 * fees stay inside the market leg rather than being fabricated as a row.
 * Fees live on the legs that incur them; the UI derives the fee copy from
 * the leg set, never from static market metadata. A quote that reverts
 * (market capacity exceeded) is the honest "can't fill this size" — never
 * a partial quote.
 */

import type { Address } from "viem";
import type {
  AssetId,
  TradeAvailability,
  TradeLeg,
  TradeQuote,
  TradeRequest,
} from "@/domain/types";
import {
  applyBps,
  floorToLedgerGrain,
  formatGpuUnits,
  GPU_LEDGER_GRAIN,
  parseGpuUnits,
  parseGusd,
} from "@/domain/units";
import { gpuIdForAsset } from "../gpu-id";
import { canonicalPoolKey } from "../pool";
import { getContracts } from "../contracts";
import { getPublicClient } from "../public-client";
import { contractReads, type ContractReads } from "../reads";
import { issueUnitsForSpend } from "./genesis";

/** Slippage tolerance the slip offers, bps (the presets row). */
export const TOLERANCE_PRESETS_BPS = [10, 50, 100] as const;
export const DEFAULT_TOLERANCE_BPS = 50;

export interface QuoteDeps {
  reads: ContractReads;
  contracts: ReturnType<typeof getContracts>;
  getBlockNumber(): Promise<number>;
  now(): number;
}

export function defaultQuoteDeps(): QuoteDeps {
  return {
    reads: contractReads(),
    contracts: getContracts(),
    getBlockNumber: async () => Number(await getPublicClient().getBlockNumber()),
    now: Date.now,
  };
}

const UINT128_MAX = 2n ** 128n - 1n;

/** One single-pool quote argument — the v4 quoter's own params struct. */
export interface QuoteSingleParams {
  poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  zeroForOne: boolean;
  exactAmount: bigint;
  hookData: "0x";
}

/**
 * The quoters' quote functions are declared nonpayable (they call the
 * poolManager's unlock), so viem's getContract files them under write —
 * but they are pure simulations executed by eth_call. The read surface is
 * the honest seam; it is cast to the signatures the desks use.
 *
 * `QuoterRead` is the stock v4 quoter — still the pricing path for the
 * hook-free stable pool (the mint desk's StableRouter swap leg). GPU pools
 * quote through `GpuQuoterRead` (the float-seeded lens), which returns the
 * decomposed QuoteResult.
 */
export interface QuoterRead {
  quoteExactOutputSingle(args: [QuoteSingleParams]): Promise<[bigint, bigint]>;
  quoteExactInputSingle(args: [QuoteSingleParams]): Promise<[bigint, bigint]>;
}

export function quoterReadFor(contracts: ReturnType<typeof getContracts>): QuoterRead {
  return contracts.quoter.read as unknown as QuoterRead;
}

function quoterRead(deps: QuoteDeps): QuoterRead {
  return quoterReadFor(deps.contracts);
}

/**
 * GpuQuoter.QuoteResult — the composed market's answer, decomposed by fill
 * source. viem decodes fully-named structs into objects, so this mirrors
 * the Solidity struct field-for-field.
 */
export interface GpuQuoteResult {
  isBuy: boolean;
  exactIn: boolean;
  /** Buys: total gUSD the swapper pays (0 for sells). */
  gusdIn: bigint;
  /** Sells: net gUSD the swapper receives (0 for buys). */
  gusdOut: bigint;
  /** Sells: total GPU the swapper sells (0 for buys). */
  gpuIn: bigint;
  /** Buys: total GPU the swapper receives (0 for sells). */
  gpuOut: bigint;
  /** GPU filled by the native CL book. */
  nativeGpu: bigint;
  /** GPU filled by POL inventory. */
  polGpu: bigint;
  /** GPU minted by the issuance backstop. */
  backstopGpu: bigint;
  /** POL fee charged. */
  polFeeGusd: bigint;
  /** Hook fee charged in gUSD (buys and sells alike when hookFeeBps > 0). */
  hookFeeGusd: bigint;
  /** Backstop principal (buys only). */
  issueBase: bigint;
  /** Backstop fee (buys only). */
  issueFee: bigint;
  /** Pool tick after the native leg. */
  endTick: number;
}

export interface GpuQuoterRead {
  /** Exact-out buy: units demanded → gUSD spent. */
  quoteBuyExactOut(args: [GpuPoolKeyArg, bigint]): Promise<GpuQuoteResult>;
  /** Exact-in buy: gUSD spent → net units received. */
  quoteBuy(args: [GpuPoolKeyArg, bigint]): Promise<GpuQuoteResult>;
  /** Exact-in sell: units sold → net gUSD received. */
  quoteSell(args: [GpuPoolKeyArg, bigint]): Promise<GpuQuoteResult>;
  /** Exact-out sell: gUSD proceeds demanded → gross units to sell. */
  quoteSellExactOut(args: [GpuPoolKeyArg, bigint]): Promise<GpuQuoteResult>;
}

/** GpuQuoter's PoolKey parameter — same fields as the v4 pool key. */
export type GpuPoolKeyArg = QuoteSingleParams["poolKey"];

export function gpuQuoterReadFor(contracts: ReturnType<typeof getContracts>): GpuQuoterRead {
  return contracts.gpuQuoter.read as unknown as GpuQuoterRead;
}

function gpuQuoterRead(deps: QuoteDeps): GpuQuoterRead {
  return gpuQuoterReadFor(deps.contracts);
}

/** Availability read for the slip's gate — null when unregistered. Short
 *  TTL so the desk header and the slip share one read without drift. */
export async function describeAsset(
  asset: AssetId,
  deps: QuoteDeps = defaultQuoteDeps(),
): Promise<TradeAvailability | null> {
  const cached = availabilityCache.get(asset);
  if (cached && Date.now() - cached.at < AVAILABILITY_TTL_MS) {
    return cached.value;
  }
  let gpuId: `0x${string}`;
  try {
    gpuId = gpuIdForAsset(asset);
  } catch {
    return null;
  }
  const reg = await deps.reads.registration(gpuId);
  const oracle = reg ? await deps.reads.oracleUpdatedAt(gpuId) : null;
  const value = reg
    ? {
        issuanceEnabled: reg.issuanceEnabled,
        poolRegistered: reg.poolRegistered,
        // v4 fee units are hundredths of a bip (3000 = 0.30%) — the
        // availability surface speaks bps, so convert here once.
        poolFeeBps: Number(reg.poolParams.fee) / 100,
        hookFeeBps: await deps.reads.hookFeeBps(),
        issuanceFeeBps: reg.issuanceFeeBps,
        // The oracle's own 4-decimal fixed point → gUSD per unit. A
        // stale or empty publication is no reference at all.
        oraclePrice:
          oracle && !oracle.isStale && oracle.rawPrice > 0n
            ? Number(oracle.rawPrice) / 10_000
            : null,
      }
    : null;
  availabilityCache.set(asset, { at: Date.now(), value });
  return value;
}

const AVAILABILITY_TTL_MS = 15_000;
const availabilityCache = new Map<AssetId, { at: number; value: TradeAvailability | null }>();

/** Drop the availability cache (tests). */
export function disposeAvailabilityCache(): void {
  availabilityCache.clear();
}

/** Buy quote: exact-out, the composed market (native → POL → backstop),
 *  `maxPaid` cap with tolerance. Genesis pools (no canonical pool yet)
 *  price through primary issuance alone. */
export async function quoteBuy(
  asset: AssetId,
  size: number,
  toleranceBps: number = DEFAULT_TOLERANCE_BPS,
  deps: QuoteDeps = defaultQuoteDeps(),
): Promise<TradeQuote | null> {
  if (!Number.isFinite(size) || size <= 0) return null;
  let gpuId: `0x${string}`;
  try {
    gpuId = gpuIdForAsset(asset);
  } catch {
    return null;
  }
  const reg = await deps.reads.registration(gpuId);
  if (!reg) return null;
  const sizeRaw = parseGpuUnits(size);
  if (sizeRaw === 0n || sizeRaw > UINT128_MAX) return null;

  const blockNumber = await deps.getBlockNumber();

  if (!reg.poolRegistered) {
    // Genesis: no secondary market exists — the whole size prices through
    // primary issuance. Closed issuance means the size is not buyable.
    if (!reg.issuanceEnabled) return null;
    const [base, fee, total] = await deps.contracts.issuance.read.quoteIssue([gpuId, sizeRaw]);
    if (base === 0n && total === 0n) return null; // no oracle publication
    const maxPaidRaw = applyBps(total, toleranceBps, "up");
    return {
      asset,
      side: "buy",
      size,
      price: Number(total) / 1e6 / size,
      notional: Number(total) / 1e6,
      maxPaid: Number(maxPaidRaw) / 1e6,
      minOut: 0,
      minSize: 0,
      legs: [
        {
          kind: "issuance",
          gpuUnits: size,
          gUsd: Number(total) / 1e6,
          fees: { issuance: Number(fee) / 1e6 },
        },
      ],
      toleranceBps,
      quotedAtMs: deps.now(),
      blockNumber,
    };
  }

  const { addresses } = deps.contracts;
  const poolKey = canonicalPoolKey(
    addresses.gusd as Address,
    reg.token,
    reg.poolParams,
    addresses.hook as Address,
  );

  let r: GpuQuoteResult;
  try {
    r = await gpuQuoterRead(deps).quoteBuyExactOut([poolKey, sizeRaw]);
  } catch {
    return null; // the market cannot fill this size — the honest "can't quote"
  }
  if (r.gpuOut !== sizeRaw || r.gusdIn === 0n) return null;

  // Legs carry their own fees — the UI derives the fee copy from this set,
  // so the slip never shows a fee this fill doesn't incur. gusdIn is all-in:
  // the market portion is what remains after the backstop's principal+fee,
  // and the protocol's gUSD take rides inside it (split out for the fee
  // line only — the row that signs is the all-in total).
  const legs: TradeLeg[] = [];
  const marketGpu = r.nativeGpu + r.polGpu;
  const backstopGusd = r.issueBase + r.issueFee;
  if (marketGpu > 0n) {
    legs.push({
      kind: "pool",
      gpuUnits: formatGpuUnits(marketGpu),
      gUsd: Number(r.gusdIn - backstopGusd) / 1e6,
      fees: { protocol: Number(r.polFeeGusd + r.hookFeeGusd) / 1e6 },
    });
  }
  if (r.backstopGpu > 0n) {
    legs.push({
      kind: "issuance",
      gpuUnits: formatGpuUnits(r.backstopGpu),
      gUsd: Number(backstopGusd) / 1e6,
      fees: { issuance: Number(r.issueFee) / 1e6 },
    });
  }

  const maxPaidRaw = applyBps(r.gusdIn, toleranceBps, "up");

  return {
    asset,
    side: "buy",
    size,
    price: Number(r.gusdIn) / 1e6 / size,
    notional: Number(r.gusdIn) / 1e6,
    maxPaid: Number(maxPaidRaw) / 1e6,
    minOut: 0,
    minSize: 0,
    legs,
    toleranceBps,
    quotedAtMs: deps.now(),
    blockNumber,
  };
}

/** Sell quote: exact-in, all proceeds to gUSD, `minOut` floor with
 *  tolerance. Sells fill from the native book and the POL bid only —
 *  there is no synthetic redemption, so a pool-less asset cannot sell. */
export async function quoteSell(
  asset: AssetId,
  size: number,
  toleranceBps: number = DEFAULT_TOLERANCE_BPS,
  deps: QuoteDeps = defaultQuoteDeps(),
): Promise<TradeQuote | null> {
  if (!Number.isFinite(size) || size <= 0) return null;
  let gpuId: `0x${string}`;
  try {
    gpuId = gpuIdForAsset(asset);
  } catch {
    return null;
  }
  const reg = await deps.reads.registration(gpuId);
  if (!reg || !reg.poolRegistered) return null; // sells need secondary depth
  const sizeRaw = parseGpuUnits(size);
  if (sizeRaw === 0n || sizeRaw > UINT128_MAX) return null;

  const { addresses } = deps.contracts;
  const poolKey = canonicalPoolKey(
    addresses.gusd as Address,
    reg.token,
    reg.poolParams,
    addresses.hook as Address,
  );

  const blockNumber = await deps.getBlockNumber();
  let r: GpuQuoteResult;
  try {
    r = await gpuQuoterRead(deps).quoteSell([poolKey, sizeRaw]);
  } catch {
    return null; // no depth — the honest "can't quote"
  }
  if (r.gusdOut === 0n || r.gpuIn !== sizeRaw) return null;

  // The seller receives gusdOut net of the protocol's take; the fee line
  // names what was charged on the fills. The row that signs is the net.
  const minOutRaw = applyBps(r.gusdOut, toleranceBps, "down");

  return {
    asset,
    side: "sell",
    size,
    price: Number(r.gusdOut) / 1e6 / size,
    notional: Number(r.gusdOut) / 1e6,
    maxPaid: 0,
    minOut: Number(minOutRaw) / 1e6,
    minSize: 0,
    legs: [
      {
        kind: "pool",
        gpuUnits: size,
        gUsd: Number(r.gusdOut) / 1e6,
        fees: { protocol: Number(r.polFeeGusd + r.hookFeeGusd) / 1e6 },
      },
    ],
    toleranceBps,
    quotedAtMs: deps.now(),
    blockNumber,
  };
}

/** Money-first buy: exact-in on the pool — the swapper spends exactly the
 *  typed gUSD (`buyExactIn` pulls it all, nothing is refunded), so the
 *  spend cap IS the typed amount and the tolerance only moves the minimum
 *  units floor (`minSize`). Genesis pools have no pool to exact-in against:
 *  the spend inverts against primary issuance instead (see ./genesis) and
 *  rides the exact-out path under the typed-spend cap. */
export async function quoteBuyBySpend(
  asset: AssetId,
  gusd: number,
  toleranceBps: number = DEFAULT_TOLERANCE_BPS,
  deps: QuoteDeps = defaultQuoteDeps(),
): Promise<TradeQuote | null> {
  if (!Number.isFinite(gusd) || gusd <= 0) return null;
  let gpuId: `0x${string}`;
  try {
    gpuId = gpuIdForAsset(asset);
  } catch {
    return null;
  }
  const reg = await deps.reads.registration(gpuId);
  if (!reg) return null;
  const spendRaw = parseGusd(gusd);
  if (spendRaw === 0n || spendRaw > UINT128_MAX) return null;

  const blockNumber = await deps.getBlockNumber();

  if (!reg.poolRegistered) {
    // Genesis: solve the largest ledger-grain unit count the spend covers,
    // quoted on the contract's own math. No publication or a stale oracle
    // means issue() would revert — the honest "can't quote".
    if (!reg.issuanceEnabled) return null;
    const oracle = await deps.reads.oracleUpdatedAt(gpuId);
    if (oracle.isStale || oracle.rawPrice === 0n) return null;
    const solved = await issueUnitsForSpend(spendRaw, oracle.rawPrice, reg.issuanceFeeBps, (amountRaw) => {
      const q = deps.contracts.issuance.read.quoteIssue([gpuId, amountRaw]);
      return q.then(([base, fee, total]) => ({ base, fee, total }));
    });
    if (!solved) return null;

    const size = formatGpuUnits(solved.units);
    const notional = Number(solved.quote.total) / 1e6;
    return {
      asset,
      side: "buy",
      size,
      price: notional / size,
      notional,
      // Exact-out under a refundable cap: the typed spend bounds it, the
      // tail comes back. The floor is the solved size itself.
      maxPaid: gusd,
      minOut: 0,
      minSize: size,
      legs: [
        {
          kind: "issuance",
          gpuUnits: size,
          gUsd: notional,
          fees: { issuance: Number(solved.quote.fee) / 1e6 },
        },
      ],
      toleranceBps,
      quotedAtMs: deps.now(),
      blockNumber,
    };
  }

  const { addresses } = deps.contracts;
  const poolKey = canonicalPoolKey(
    addresses.gusd as Address,
    reg.token,
    reg.poolParams,
    addresses.hook as Address,
  );

  let r: GpuQuoteResult;
  try {
    r = await gpuQuoterRead(deps).quoteBuy([poolKey, spendRaw]);
  } catch {
    return null; // the market cannot absorb this spend — the honest "can't quote"
  }
  // The exact-in quoter must spend exactly what was typed and deliver a
  // fillable size; anything else is dust or a degenerate pool. The signed
  // floor must reach one ledger grain — below it the minimum can't print
  // and the order would sign floor-less.
  const minSizeRaw = floorToLedgerGrain(applyBps(r.gpuOut, toleranceBps, "down"));
  if (r.gusdIn !== spendRaw || r.gpuOut === 0n || minSizeRaw === 0n) return null;

  // Legs decompose exactly like the size-first quote — the backstop's
  // principal+fee is the issuance share, the rest is the market leg. The
  // hook fee is taken in-kind in GPU on exact-in buys, so hookFeeGusd
  // reads 0 here: the fee rides inside the all-in price, not beside it.
  const legs: TradeLeg[] = [];
  const marketGpu = r.nativeGpu + r.polGpu;
  const backstopGusd = r.issueBase + r.issueFee;
  if (marketGpu > 0n) {
    legs.push({
      kind: "pool",
      gpuUnits: formatGpuUnits(marketGpu),
      gUsd: Number(r.gusdIn - backstopGusd) / 1e6,
      fees: { protocol: Number(r.polFeeGusd + r.hookFeeGusd) / 1e6 },
    });
  }
  if (r.backstopGpu > 0n) {
    legs.push({
      kind: "issuance",
      gpuUnits: formatGpuUnits(r.backstopGpu),
      gUsd: Number(backstopGusd) / 1e6,
      fees: { issuance: Number(r.issueFee) / 1e6 },
    });
  }

  const size = formatGpuUnits(r.gpuOut);
  const notional = Number(r.gusdIn) / 1e6;

  return {
    asset,
    side: "buy",
    size,
    price: notional / size,
    notional,
    maxPaid: gusd,
    minOut: 0,
    minSize: formatGpuUnits(minSizeRaw),
    legs,
    toleranceBps,
    quotedAtMs: deps.now(),
    blockNumber,
  };
}

/** Money-first sell: proceeds-first. The quoter solves the gross units
 *  whose net payout is the typed demand (seller fees ride inside those
 *  units), and execution is the ordinary exact-in `router.sell` — sell the
 *  derived units under the payout floor. The pool is the only sell depth. */
export async function quoteSellByProceeds(
  asset: AssetId,
  gusd: number,
  toleranceBps: number = DEFAULT_TOLERANCE_BPS,
  deps: QuoteDeps = defaultQuoteDeps(),
): Promise<TradeQuote | null> {
  if (!Number.isFinite(gusd) || gusd <= 0) return null;
  let gpuId: `0x${string}`;
  try {
    gpuId = gpuIdForAsset(asset);
  } catch {
    return null;
  }
  const reg = await deps.reads.registration(gpuId);
  if (!reg || !reg.poolRegistered) return null; // sells need secondary depth
  const proceedsRaw = parseGusd(gusd);
  if (proceedsRaw === 0n || proceedsRaw > UINT128_MAX) return null;

  const { addresses } = deps.contracts;
  const poolKey = canonicalPoolKey(
    addresses.gusd as Address,
    reg.token,
    reg.poolParams,
    addresses.hook as Address,
  );

  const blockNumber = await deps.getBlockNumber();
  let r: GpuQuoteResult;
  try {
    r = await gpuQuoterRead(deps).quoteSellExactOut([poolKey, proceedsRaw]);
  } catch {
    return null; // no depth for this payout — the honest "can't quote"
  }
  // The exact-out sell must deliver exactly the typed demand and cost a
  // fillable size — below one ledger grain the units can't even print.
  if (r.gusdOut !== proceedsRaw || r.gpuIn < GPU_LEDGER_GRAIN) return null;

  const size = formatGpuUnits(r.gpuIn);
  const notional = Number(r.gusdOut) / 1e6;
  const minOutRaw = applyBps(r.gusdOut, toleranceBps, "down");

  return {
    asset,
    side: "sell",
    size,
    price: notional / size,
    notional,
    maxPaid: 0,
    minOut: Number(minOutRaw) / 1e6,
    minSize: 0,
    legs: [
      {
        kind: "pool",
        gpuUnits: formatGpuUnits(r.gpuIn),
        gUsd: Number(r.gusdOut) / 1e6,
        fees: { protocol: Number(r.polFeeGusd + r.hookFeeGusd) / 1e6 },
      },
    ],
    toleranceBps,
    quotedAtMs: deps.now(),
    blockNumber,
  };
}

/** The slip's single quoting seam — dispatches on the request's basis and
 *  side. Every basis executes under the limits its quote signed. */
export async function quoteAsset(
  request: TradeRequest,
  deps: QuoteDeps = defaultQuoteDeps(),
): Promise<TradeQuote | null> {
  const toleranceBps = request.toleranceBps ?? DEFAULT_TOLERANCE_BPS;
  if (request.basis === "gusd") {
    return request.side === "buy"
      ? quoteBuyBySpend(request.asset, request.gusd, toleranceBps, deps)
      : quoteSellByProceeds(request.asset, request.gusd, toleranceBps, deps);
  }
  return request.side === "buy"
    ? quoteBuy(request.asset, request.size, toleranceBps, deps)
    : quoteSell(request.asset, request.size, toleranceBps, deps);
}
