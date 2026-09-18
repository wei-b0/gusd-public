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
 * The price input is the pull oracle's signed Report: every quote first
 * fetches the CURRENT epoch's attestation (QuoteDeps.attestation) and
 * prices either through hook.polState (which verifies the report on-chain)
 * or the contract's quoteIssue against its updateData. Quotes without a
 * current report are impossible — matching the contract, where no fill
 * happens without one either.
 *
 * Two quoting paths, dispatched by the pool's native liquidity:
 *  - No native CL liquidity (the launch configuration — every fill is
 *    hook-driven): the deterministic mirror in ./hook-quote, pure
 *    arithmetic over the hook's public state. The float-seeded lens would
 *    bound every quote to its private simulation float; the mirror is the
 *    market's real depth.
 *  - Native liquidity present: the float-seeded GpuQuoter, which runs the
 *    pool's real hook inside an eth_call — the walk leg is real there and
 *    the mirror deliberately does not reimplement it.
 *
 * Neither path pre-commits the fill: state can move between read and
 * inclusion, so execution is bounded by the signed limits (`maxPaid` /
 * `minOut` / `minSize`), not the quote. A mirror rejection carries the
 * market's capacity in the quote's own units (QuoteFailure.capacityRaw)
 * so the slip can say "this market fills at most X" instead of a bare
 * error. A lapsed report — the one perishable input — never speaks that
 * voice at all: the quote refetches and re-quotes (withLiveReport), and
 * a revert with no mirror available maps to the honest transient voices
 * (oracle-stale / quote-timeout), never to capacity.
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
  QuoteFailure,
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
import { canonicalPoolKey, poolIdOf } from "../pool";
import { getContracts } from "../contracts";
import { getPublicClient } from "../public-client";
import { contractReads, type ContractReads } from "../reads";

/** The registration row the desk's report-independent prelude fetches —
 *  the OnReport bodies take it as a plain argument. */
type Registration = NonNullable<Awaited<ReturnType<ContractReads["registration"]>>>;
import { fetchAttestation, type Attestation } from "@/data/oracle/attestation";
import type { SignedReport } from "@gusd/attestor-client";
import {
  oracleGuardOk,
  quoteBuyExactOutMirror,
  quoteBuyMirror,
  quoteSellExactOutMirror,
  quoteSellMirror,
  type HookMarketState,
} from "./hook-quote";
import { issueUnitsForSpend } from "./genesis";

/** Slippage tolerance the slip offers, bps (the presets row). */
export const TOLERANCE_PRESETS_BPS = [10, 50, 100] as const;
export const DEFAULT_TOLERANCE_BPS = 50;

export interface QuoteDeps {
  reads: ContractReads;
  contracts: ReturnType<typeof getContracts>;
  getBlockNumber(): Promise<number>;
  now(): number;
  /** The attestation fetch — the signed report a trade embeds. Injectable
   *  for tests; execution pins ONE report across re-quote → simulate →
   *  sign by handing this quote stack a deps whose fetch returns it. */
  attestation(gpuParam: string): Promise<Attestation>;
  /** Pacing between attestation re-fetches in the boundary bridge.
   *  Injectable for tests (no-op); production paces with setTimeout. */
  sleep?(ms: number): Promise<void>;
}

export function defaultQuoteDeps(): QuoteDeps {
  return {
    reads: contractReads(),
    contracts: getContracts(),
    getBlockNumber: async () => Number(await getPublicClient().getBlockNumber()),
    now: Date.now,
    attestation: (gpuParam) => fetchAttestation(gpuParam),
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
  quoteBuyExactOut(args: [GpuPoolKeyArg, bigint, `0x${string}`]): Promise<GpuQuoteResult>;
  /** Exact-in buy: gUSD spent → net units received. */
  quoteBuy(args: [GpuPoolKeyArg, bigint, `0x${string}`]): Promise<GpuQuoteResult>;
  /** Exact-in sell: units sold → net gUSD received. */
  quoteSell(args: [GpuPoolKeyArg, bigint, `0x${string}`]): Promise<GpuQuoteResult>;
  /** Exact-out sell: gUSD proceeds demanded → gross units to sell. */
  quoteSellExactOut(args: [GpuPoolKeyArg, bigint, `0x${string}`]): Promise<GpuQuoteResult>;
}

/** GpuQuoter's PoolKey parameter — same fields as the v4 pool key. */
export type GpuPoolKeyArg = QuoteSingleParams["poolKey"];

export function gpuQuoterReadFor(contracts: ReturnType<typeof getContracts>): GpuQuoterRead {
  return contracts.gpuQuoter.read as unknown as GpuQuoterRead;
}

function gpuQuoterRead(deps: QuoteDeps): GpuQuoterRead {
  return gpuQuoterReadFor(deps.contracts);
}

/** Why a quote didn't come back — the slip's message maps 1:1 off these.
 *  The type lives in the domain layer (the port and the slip consume it);
 *  re-exported here as the quoting seam's own vocabulary. */
export type { QuoteFailure } from "@/domain/types";

/** The deterministic mirror's one hook-state read — shared per quote so a
 *  four-desk batch doesn't fan out 4× the same 12 reads. Priced at the
 *  verified report the trade will embed. */
interface MirrorBatch {
  state: HookMarketState;
  /** The pool's native CL liquidity, raw. 0 = hook-driven (the mirror's
   *  jurisdiction); > 0 = the float-seeded simulation. */
  nativeLiquidity: bigint;
}

async function mirrorBatch(
  deps: QuoteDeps,
  gpuId: `0x${string}`,
  poolKey: GpuPoolKeyArg,
  signed: SignedReport,
): Promise<MirrorBatch | null> {
  try {
    const state = await deps.reads.hookMarketState(gpuId, signed);
    const nativeLiquidity = await deps.contracts.stateView.read
      .getLiquidity([poolIdOf(poolKey)])
      .catch(() => 0n);
    return { state, nativeLiquidity };
  } catch {
    // The mirror is an upgrade, never a dependency: a seam without the
    // hook-state read (older port, partial test fakes) quotes through the
    // float-seeded lens exactly as before.
    return null;
  }
}

/** The GPU pools' quoting seam — the two-path dispatch of the module doc.
 *  Returns the decomposed result, or the typed failure the slip maps to
 *  its message. Both paths price the SAME signed report (`updateData` rides
 *  the eth_call on the float path; the mirror's state was verified from
 *  it). */
async function runGpuQuote(
  deps: QuoteDeps,
  batch: MirrorBatch | null,
  poolKey: GpuPoolKeyArg,
  method: "quoteBuyExactOut" | "quoteBuy" | "quoteSell" | "quoteSellExactOut",
  amountRaw: bigint,
  updateData: `0x${string}`,
  reportValidUntilSec: number,
): Promise<QuoteFailure | GpuQuoteResult> {
  const nowSec = Math.floor(deps.now() / 1000);
  const mirror =
    method === "quoteBuyExactOut"
      ? quoteBuyExactOutMirror
      : method === "quoteBuy"
        ? quoteBuyMirror
        : method === "quoteSell"
          ? quoteSellMirror
          : quoteSellExactOutMirror;
  if (batch !== null && batch.nativeLiquidity === 0n) {
    const m = mirror(batch.state, amountRaw, nowSec);
    if (m.ok) return { ...m.r, nativeGpu: 0n, endTick: 0 };
    return { unavailable: true, reason: m.reason, capacityRaw: m.capacityRaw };
  }
  try {
    return await gpuQuoterRead(deps)[method]([poolKey, amountRaw, updateData]);
  } catch {
    if (batch === null) {
      // The state batch died before the mirror could run AND the quoter
      // reverted with it. Neither throw names a reason — polState and the
      // simulation revert bare. With a lapsed report this is the epoch
      // boundary crossing (the heal above refetches and re-quotes); with
      // a live report it is infrastructure (one RPC read failed and the
      // simulation with it). NEITHER is depth: a real capacity fact
      // always arrives from the mirror, with a figure attached.
      if (reportValidUntilSec <= nowSec) return { unavailable: true, reason: "oracle-stale" };
      return { unavailable: true, reason: "quote-timeout" };
    }
    if (!oracleGuardOk(batch.state, nowSec)) {
      return { unavailable: true, reason: "oracle-stale" };
    }
    // The lens's simulation float is seeded per-SKU, so a size beyond it
    // reverts the SIMULATION while the hook's real inventory (primary-
    // capitalized) may still fill — the mirror prices the real market the
    // trade will ride (the P0 fix). Its own rejection carries the capacity
    // the bid book can actually absorb.
    const m = mirror(batch.state, amountRaw, nowSec);
    if (m.ok) return { ...m.r, nativeGpu: 0n, endTick: 0 };
    return { unavailable: true, reason: m.reason, capacityRaw: m.capacityRaw };
  }
}

/** The current-epoch attestation, or the typed refusal: a quote cannot run
 *  without one — the contract itself refuses (ReportRequired / epoch
 *  checks), so the quote says the same thing in its own vocabulary. The
 *  fetch names the market's canonical bytes32 gpuId — the one key the
 *  contract, the report, and the API all agree on. */
async function currentAttestation(deps: QuoteDeps, gpuId: `0x${string}`): Promise<
  { att: Attestation & { kind: "current" } } | QuoteFailure
> {
  const att = await deps.attestation(gpuId);
  if (att.kind !== "current") return { unavailable: true, reason: "oracle-stale" };
  return { att };
}

/** The boundary bridge. The attestor renews the report at every epoch
 *  boundary (the 60s grid; its first tick lands within seconds of it), so
 *  a fetch that answers non-current is most often a quote that arrived
 *  inside that renewal gap. A short in-call re-poll crosses it; past the
 *  budget the typed refusal stands — the fail-closed gate is untouched,
 *  the quote just refuses patiently instead of refusing instantly. */
const REPORT_BRIDGE_MS = 600;
const REPORT_BRIDGE_ATTEMPTS = 2;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function currentAttestationLive(
  deps: QuoteDeps,
  gpuId: `0x${string}`,
): Promise<{ att: Attestation & { kind: "current" } } | QuoteFailure> {
  const sleep = deps.sleep ?? defaultSleep;
  let attested = await currentAttestation(deps, gpuId);
  for (let i = 0; i < REPORT_BRIDGE_ATTEMPTS && "unavailable" in attested; ++i) {
    await sleep(REPORT_BRIDGE_MS);
    attested = await currentAttestation(deps, gpuId);
  }
  return attested;
}

/** True when the report's validity window has closed by nowMs — a report
 *  that lapses mid-quote reverts every report-bearing read (polState, the
 *  quoter simulation) with a bare revert that carries no reason to map. */
function reportLapsed(att: Extract<Attestation, { kind: "current" }>, nowMs: number): boolean {
  return att.signed.report.validUntil <= Math.floor(nowMs / 1000);
}

/**
 * The epoch-boundary heal — the seam that keeps trading from halting on a
 * perishable input it can simply refetch. A quote is pinned to exactly one
 * report; when that report lapses before the quote's reads complete, the
 * reverts it causes once surfaced as "no depth" — indistinguishable from a
 * dead market, and false. So: if the pinned report has lapsed by the time
 * the quote answered, refetch and quote again on the fresh report. Every
 * other outcome — a genuine capacity fact, a null, a refusal with a live
 * report — passes through untouched.
 */
async function withLiveReport(
  deps: QuoteDeps,
  gpuId: `0x${string}`,
  work: (att: Extract<Attestation, { kind: "current" }>) => Promise<TradeQuote | QuoteFailure | null>,
): Promise<TradeQuote | QuoteFailure | null> {
  let attested = await currentAttestationLive(deps, gpuId);
  for (let attempts = 0; ; ++attempts) {
    if ("unavailable" in attested) return attested;
    const result = await work(attested.att);
    if (result === null || !("unavailable" in result)) return result;
    // One heal per quote: past it the refusal is a fact, not a race.
    if (attempts >= 1 || !reportLapsed(attested.att, deps.now())) return result;
    const fresh = await currentAttestationLive(deps, gpuId);
    if ("unavailable" in fresh || fresh.att.reportHash === attested.att.reportHash) {
      // Nothing fresher exists (the attestor is still on the old epoch) —
      // the honest staleness refusal stands and the desk's own retry
      // cadence carries it from here.
      return result;
    }
    attested = fresh;
  }
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
  // The desk's reference price is the current attestation's report price —
  // the 4-dec fixed point the protocol actually executes against. No
  // current attestation (attestor behind, gpu never attested) is no
  // reference at all.
  const att = reg ? await deps.attestation(gpuId) : null;
  const value = reg
    ? {
        issuanceEnabled: reg.issuanceEnabled,
        poolRegistered: reg.poolRegistered,
        // v4 fee units are hundredths of a bip (3000 = 0.30%) — the
        // availability surface speaks bps, so convert here once.
        poolFeeBps: Number(reg.poolParams.fee) / 100,
        hookFeeBps: await deps.reads.hookFeeBps(),
        issuanceFeeBps: reg.issuanceFeeBps,
        // The report's 4-decimal price → gUSD per unit.
        oraclePrice:
          att && att.kind === "current" && att.signed.report.price > 0n
            ? Number(att.signed.report.price) / 10_000
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
): Promise<TradeQuote | QuoteFailure | null> {
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
  return withLiveReport(deps, gpuId, (att) =>
    quoteBuyOnReport(gpuId, asset, size, toleranceBps, deps, reg, sizeRaw, att),
  );
}

/** quoteBuy's report-bearing body, run under withLiveReport's heal: the
 *  attestation is pinned by the wrapper, so a report that lapses
 *  mid-quote is refetched and the whole body re-run on the fresh one. */
async function quoteBuyOnReport(
  gpuId: `0x${string}`,
  asset: AssetId,
  size: number,
  toleranceBps: number,
  deps: QuoteDeps,
  reg: Registration,
  sizeRaw: bigint,
  att: Extract<Attestation, { kind: "current" }>,
): Promise<TradeQuote | QuoteFailure | null> {
  const blockNumber = await deps.getBlockNumber();

  if (!reg.poolRegistered) {
    // Genesis: no secondary market exists — the whole size prices through
    // primary issuance against the report. Closed issuance means the size
    // is not buyable.
    if (!reg.issuanceEnabled) return null;
    // The read seam quotes in product units (gUSD floats) — the raw bigints
    // stay inside reads.ts. The tolerance cap needs raw precision, so parse
    // the all-in total back to its 6-dec fixed point for the bps math.
    let totalPaid: number, feePaid: number;
    try {
      const quote = await deps.reads.quoteIssue(gpuId, sizeRaw, att.updateData);
      totalPaid = quote.totalPaid;
      feePaid = quote.fee;
    } catch {
      // The report stopped being executable (epoch rolled mid-quote) —
      // the same refusal the mirror would give.
      return { unavailable: true, reason: "oracle-stale" };
    }
    const maxPaid = Number(applyBps(parseGusd(totalPaid), toleranceBps, "up")) / 1e6;
    return {
      asset,
      side: "buy",
      size,
      price: totalPaid / size,
      notional: totalPaid,
      maxPaid,
      minOut: 0,
      minSize: 0,
      legs: [
        {
          kind: "issuance",
          gpuUnits: size,
          gUsd: totalPaid,
          fees: { issuance: feePaid },
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

  const batch = await mirrorBatch(deps, gpuId, poolKey, att.signed);
  const outcome = await runGpuQuote(
    deps, batch, poolKey, "quoteBuyExactOut", sizeRaw, att.updateData, att.signed.report.validUntil,
  );
  if ("unavailable" in outcome) return outcome;
  const r = outcome;
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
): Promise<TradeQuote | QuoteFailure | null> {
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
  return withLiveReport(deps, gpuId, (att) =>
    quoteSellOnReport(gpuId, asset, size, toleranceBps, deps, reg, sizeRaw, att),
  );
}

/** quoteSell's report-bearing body, run under withLiveReport's heal. */
async function quoteSellOnReport(
  gpuId: `0x${string}`,
  asset: AssetId,
  size: number,
  toleranceBps: number,
  deps: QuoteDeps,
  reg: Registration,
  sizeRaw: bigint,
  att: Extract<Attestation, { kind: "current" }>,
): Promise<TradeQuote | QuoteFailure | null> {
  const { addresses } = deps.contracts;
  const poolKey = canonicalPoolKey(
    addresses.gusd as Address,
    reg.token,
    reg.poolParams,
    addresses.hook as Address,
  );

  const blockNumber = await deps.getBlockNumber();
  const batch = await mirrorBatch(deps, gpuId, poolKey, att.signed);
  const outcome = await runGpuQuote(
    deps, batch, poolKey, "quoteSell", sizeRaw, att.updateData, att.signed.report.validUntil,
  );
  if ("unavailable" in outcome) return outcome;
  const r = outcome;
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
): Promise<TradeQuote | QuoteFailure | null> {
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
  return withLiveReport(deps, gpuId, (att) =>
    quoteBuyBySpendOnReport(gpuId, asset, gusd, toleranceBps, deps, reg, spendRaw, att),
  );
}

/** quoteBuyBySpend's report-bearing body, run under withLiveReport's heal. */
async function quoteBuyBySpendOnReport(
  gpuId: `0x${string}`,
  asset: AssetId,
  gusd: number,
  toleranceBps: number,
  deps: QuoteDeps,
  reg: Registration,
  spendRaw: bigint,
  att: Extract<Attestation, { kind: "current" }>,
): Promise<TradeQuote | QuoteFailure | null> {
  const blockNumber = await deps.getBlockNumber();

  if (!reg.poolRegistered) {
    // Genesis: solve the largest ledger-grain unit count the spend covers,
    // quoted on the contract's own math against the report. Without a
    // current report issue() would revert — the honest "can't quote".
    if (!reg.issuanceEnabled) return null;
    const solved = await issueUnitsForSpend(spendRaw, att.signed.report.price, reg.issuanceFeeBps, (amountRaw) => {
      // Raw contract quote (the solver's integer math needs it unrounded);
      // a race past the epoch reverts — surfaced as the zero-total null.
      const q = deps.contracts.issuance.read
        .quoteIssue([gpuId, amountRaw, att.updateData])
        .catch(() => [0n, 0n, 0n] as const);
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

  const batch = await mirrorBatch(deps, gpuId, poolKey, att.signed);
  const outcome = await runGpuQuote(
    deps, batch, poolKey, "quoteBuy", spendRaw, att.updateData, att.signed.report.validUntil,
  );
  if ("unavailable" in outcome) return outcome;
  const r = outcome;
  // The exact-in quoter must spend exactly what was typed and deliver a
  // fillable size; anything else is dust or a degenerate pool. The signed
  // floor must reach one ledger grain — below it the minimum can't print
  // and the order would sign floor-less.
  const minSizeRaw = floorToLedgerGrain(applyBps(r.gpuOut, toleranceBps, "down"));
  if (r.gusdIn !== spendRaw || r.gpuOut === 0n || minSizeRaw === 0n) return null;

  // Legs decompose exactly like the size-first quote — the backstop's
  // principal+fee is the issuance share, the rest is the market leg. The
  // exact-in hook fee is charged in gUSD out of the absorbed budget, so
  // hookFeeGusd is nonzero and rides in fees.protocol; the delivered GPU
  // is the full gross, so the all-in price still carries it.
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
): Promise<TradeQuote | QuoteFailure | null> {
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
  return withLiveReport(deps, gpuId, (att) =>
    quoteSellByProceedsOnReport(gpuId, asset, gusd, toleranceBps, deps, reg, proceedsRaw, att),
  );
}

/** quoteSellByProceeds's report-bearing body, run under withLiveReport. */
async function quoteSellByProceedsOnReport(
  gpuId: `0x${string}`,
  asset: AssetId,
  gusd: number,
  toleranceBps: number,
  deps: QuoteDeps,
  reg: Registration,
  proceedsRaw: bigint,
  att: Extract<Attestation, { kind: "current" }>,
): Promise<TradeQuote | QuoteFailure | null> {
  const { addresses } = deps.contracts;
  const poolKey = canonicalPoolKey(
    addresses.gusd as Address,
    reg.token,
    reg.poolParams,
    addresses.hook as Address,
  );

  const blockNumber = await deps.getBlockNumber();
  const batch = await mirrorBatch(deps, gpuId, poolKey, att.signed);
  const outcome = await runGpuQuote(
    deps, batch, poolKey, "quoteSellExactOut", proceedsRaw, att.updateData, att.signed.report.validUntil,
  );
  if ("unavailable" in outcome) return outcome;
  const r = outcome;
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
 *  side, passing through typed failures so the slip can map reason →
 *  message (see QuoteFailure). */
export async function quoteAssetDetailed(
  request: TradeRequest,
  deps: QuoteDeps = defaultQuoteDeps(),
): Promise<TradeQuote | QuoteFailure | null> {
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

/** The compat seam — callers that only need a quote or null. Detailed
 *  failures (see QuoteFailure) collapse to null here. */
export async function quoteAsset(
  request: TradeRequest,
  deps: QuoteDeps = defaultQuoteDeps(),
): Promise<TradeQuote | null> {
  const outcome = await quoteAssetDetailed(request, deps);
  return outcome && "unavailable" in outcome ? null : outcome;
}
