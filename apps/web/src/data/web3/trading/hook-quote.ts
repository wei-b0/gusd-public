/**
 * Deterministic mirror of GPUHook's plan/settle arithmetic for the LP-less,
 * hook-driven configuration — the quote path that replaces the float-seeded
 * GpuQuoter simulation on pools without native CL liquidity.
 *
 * Why this exists: GpuQuoter runs the real hook inside a revert-borne
 * unlock seeded with a private float (deploy: 1,000 GPU / SKU + 2M gUSD).
 * A position larger than the float reverts the SIMULATION while the real
 * market could fill it — the vault's bid inventory and the issuance
 * backstop are the actual depth, and both are public state. Pricing is
 * deterministic (oracle price ± spread params, ceil/floor-exact), so the
 * quote is arithmetic over public views — the same doctrine the hook
 * itself holds ("execution-identical quote doctrine" in GPUIssuance).
 *
 * Scope honesty: when the pool holds native CL liquidity the walk leg
 * matters and this mirror is NOT used (quotes.ts falls back to the
 * float-seeded simulation). At launch every GPU pool is hook-driven
 * (liquidity 0), where PoolWalk.walk provably consumes w=0 and reaches
 * the edge — so the hook's `beyond` is the full budget and this mirror
 * is the pricing path that ships.
 *
 * Every function mirrors GPUHook.sol line-for-line (verified against the
 * source 2026-09): same mulDiv rounding (ceil where Solidity rounds up),
 * same cap stacking (_polCapLeft), same dust thresholds (GUSD_DUST 5,
 * GPU_DUST 1), same ladder order (POL ask inventory, then the issuance
 * backstop with the 2-wei headroom, demand-first quote). The PM's
 * physical-balance caps (R3) are deliberately absent: the router
 * pre-settles the caller's input before beforeSwap, so pmPhys never
 * binds a router-mediated trade — including it would zero-quote every
 * sell. The per-block POL usage (_polVolumeByBlock) has no public
 * getter and a swap's block starts fresh anyway, so perBlockUsedGusd
 * is structurally 0 at quote time. State between read and inclusion
 * still moves the fill — execution reverts honestly past
 * InsufficientMarketCapacity, and the slip's slippage bounds stay on.
 */

/** One market's hook state, read once per quote batch (see ContractReads
 *  hookMarketState). Everything here is a public view. */
export interface HookMarketState {
  /** The oracle's 4-dec publication (gUSD-wei per GPU-wei × 10^4 scaled
   *  per compositionDivisor) — the same input issuance and the hook price
   *  every fill with. */
  rawPrice: bigint;
  /** The publication's block timestamp, seconds. */
  oracleUpdatedAtSec: number;
  /** The hook's own staleness limit (GPUIssuance keeps a separate one). */
  hookMaxOracleStalenessSec: number;
  /** Issuance's own staleness limit — the backstop's quoteIssueCredited
   *  reverts past it even while the hook's guard still passes (the limits
   *  are independent knobs), closing the backstop leg only. */
  issuanceMaxOracleStalenessSec: number;
  /** Per-market POL spread params — hook.polState(gpuId), which applies
   *  the {50, 50, 10} default when never set. */
  askBps: number;
  bidBps: number;
  polFeeBps: number;
  polPaused: boolean;
  /** R10 caps — the hook's public values. */
  maxPolNotionalGusd: bigint;
  perBlockPolCapGusd: bigint;
  /** gUSD of POL notional booked in the swap's block. No public getter and
   *  a landing tx's block counter starts at 0 — always 0 at quote time. */
  perBlockUsedGusd: bigint;
  /** The hook's protocol fee, bps, charged in gUSD on every fill shape. */
  hookFeeBps: number;
  /** This market's primary issuance fee, bps (the backstop's fee). */
  issueFeeBps: number;
  issuanceEnabled: boolean;
  /** issuance.compositionDivisor() — the rawPrice → gUSD-wei scale. */
  compositionDivisor: bigint;
  /** Vault two-sided inventory, raw. */
  bidInventoryGusd: bigint;
  askInventoryGpu: bigint;
}

/** The four shapes' decomposition — mirrors GpuQuoter.QuoteResult exactly
 *  (minus nativeGpu/endTick, always 0 in this configuration). */
export interface MirrorQuote {
  isBuy: boolean;
  exactIn: boolean;
  gusdIn: bigint;
  gusdOut: bigint;
  gpuIn: bigint;
  gpuOut: bigint;
  polGpu: bigint;
  backstopGpu: bigint;
  polFeeGusd: bigint;
  hookFeeGusd: bigint;
  issueBase: bigint;
  issueFee: bigint;
}

export type MirrorRejection =
  /** No fresh publication — beforeSwap returns zero deltas and the empty
   *  native book reverts the swap. */
  | "oracle-stale"
  /** The issuance backstop is closed (or won't quote) and POL ask inventory
   *  can't cover the demand. capacityRaw = max buyable units. */
  | "no-ask-capacity"
  /** The POL bid can't absorb the sale within vault float and R10 caps —
   *  the hook's honest InsufficientMarketCapacity. capacityRaw is in units
   *  (exactIn) or gUSD proceeds (exactOut). */
  | "no-bid-capacity";

export type MirrorResult =
  | { ok: true; r: MirrorQuote }
  | { ok: false; reason: MirrorRejection; capacityRaw?: bigint };

const GPU_DUST = 1n; // GPU-wei absorbed by the vault (GPUHook.GPU_DUST)
const GUSD_DUST = 5n; // gUSD-wei retained by the vault (GPUHook.GUSD_DUST)

function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b) / d;
}

/** Solidity Math.mulDiv with Rounding.Ceil — reverts on d == 0 there; the
 *  callers guard d > 0 exactly as the hook does. */
function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  const p = a * b;
  const q = p / d;
  return p % d === 0n ? q : q + 1n;
}

/** GPUHook._polCapLeft — min(per-swap cap, per-block remaining); 0 kills
 *  POL for the swap (caps kill, never lift). */
function polCapLeft(s: HookMarketState): bigint {
  let c = s.maxPolNotionalGusd;
  const perBlock = s.perBlockPolCapGusd;
  if (perBlock !== 0n) {
    const used = s.perBlockUsedGusd;
    const left = perBlock > used ? perBlock - used : 0n;
    if (left < c) c = left;
  }
  return c;
}

/** The hook's guarded oracle read: zero price or past the hook's own
 *  staleness limit disables the hook deltas entirely (pure-native swap,
 *  which an LP-less pool cannot fill). */
export function oracleGuardOk(s: HookMarketState, nowSec: number): boolean {
  if (s.rawPrice === 0n) return false;
  if (s.oracleUpdatedAtSec > nowSec) return false;
  return nowSec - s.oracleUpdatedAtSec <= s.hookMaxOracleStalenessSec;
}

/** Issuance's own guard — quoteIssueCredited reverts (and issue() fails
 *  closed) past THIS limit, independent of the hook's. */
export function issuanceGuardOk(s: HookMarketState, nowSec: number): boolean {
  if (s.rawPrice === 0n) return false;
  if (s.oracleUpdatedAtSec > nowSec) return false;
  return nowSec - s.oracleUpdatedAtSec <= s.issuanceMaxOracleStalenessSec;
}

/** GPUHook._effAskBps — POL ask capped at the primary ask (R2) so the
 *  backstop can always close the residual at exactly the primary total. */
function effAskBps(s: HookMarketState): number {
  let eff = s.polPaused ? 0 : s.askBps;
  if (s.issueFeeBps < eff) eff = s.issueFeeBps;
  return eff;
}

/** GPUIssuance.quoteIssueCredited's math (execution-identical doctrine):
 *  base = ceil(amount·price / cd), fee = ceil(base·feeBps / 1e4). Null when
 *  issuance's own guard would revert (stale publication, closed market) —
 *  the hook's try/catch degrades the backstop leg to zero in exactly those
 *  cases. */
function quoteIssue(
  s: HookMarketState,
  amount: bigint,
  nowSec: number,
): { base: bigint; fee: bigint; total: bigint } | null {
  if (!issuanceGuardOk(s, nowSec)) return null;
  const base = mulDivCeil(s.rawPrice * amount, 1n, s.compositionDivisor);
  const fee = mulDivCeil(base, BigInt(s.issueFeeBps), 10_000n);
  return { base, fee, total: base + fee };
}

/** GPUHook._buyLadder — POL ask inventory first, then the issuance backstop
 *  with the 2-wei headroom and the demand-first exact quote. demandCap
 *  bounds the GPU demand (exactOut shapes); pass 2n**256n - 1n for exactIn,
 *  whose want overflows Solidity's quote and lands on the conservative
 *  budget — mirrored below via the same overflow check. */
function buyLadder(
  s: HookMarketState,
  gusdBudget: bigint,
  demandCap: bigint,
  nowSec: number,
): {
  polGpu: bigint;
  polSpend: bigint;
  polFee: bigint;
  issueGpu: bigint;
  base: bigint;
  fee: bigint;
  total: bigint;
} {
  if (gusdBudget === 0n) {
    return { polGpu: 0n, polSpend: 0n, polFee: 0n, issueGpu: 0n, base: 0n, fee: 0n, total: 0n };
  }
  const denomAsk = s.rawPrice * BigInt(10_000 + effAskBps(s));
  const capLeft = polCapLeft(s);
  const capGpu = capLeft === 0n ? 0n : mulDivFloor(capLeft, 10n ** 20n, denomAsk);
  const affordable = mulDivFloor(gusdBudget, 10n ** 20n, denomAsk);
  // GPUHook L528: min(min(affordable, askInv), min(capGpu, demandCap))
  const polGpu = minBig(affordable, s.askInventoryGpu, capGpu, demandCap);
  const polSpend = mulDivCeil(polGpu * denomAsk, 1n, 10n ** 20n);
  const polFee = mulDivCeil(polSpend, BigInt(s.polFeeBps), 10_000n);
  const leftover = gusdBudget - polSpend;
  const issueHeadroom = leftover >= 2n ? leftover - 2n : 0n;
  // L533: issueBudget = mulDiv(headroom, cd*1e4, price*(1e4+issueFeeBps)) (floor)
  const issueBudget = mulDivFloor(
    issueHeadroom * s.compositionDivisor * 10_000n,
    1n,
    s.rawPrice * BigInt(10_000 + s.issueFeeBps),
  );
  const want = demandCap - polGpu;
  // Demand-first: quote the exact residual demand; fill it when the total
  // fits the leftover (L544-558). For exactIn shapes `want` is ~2^256 and
  // Solidity's quoteIssueCredited reverts on the price·want mul — the
  // try/catch falls through to the conservative budget, mirrored by the
  // explicit overflow test.
  const overflow =
    s.rawPrice === 0n ||
    mulDivCeil(s.rawPrice * want, 1n, s.compositionDivisor) >= 2n ** 256n;
  let issueGpu = 0n;
  let base = 0n;
  let fee = 0n;
  let total = 0n;
  let filled = false;
  if (want !== 0n && s.issuanceEnabled && !overflow) {
    const q = quoteIssue(s, want, nowSec);
    if (q !== null && q.total <= leftover) {
      issueGpu = want;
      base = q.base;
      fee = q.fee;
      total = q.total;
      filled = true;
    }
  }
  if (!filled) {
    // L559-573: conservative budget, zeroed when the quote itself reverts
    // (issuance closed or its oracle stale) — fills degrade to the POL leg.
    issueGpu = minBig(want, issueBudget);
    if (issueGpu > 0n && s.issuanceEnabled) {
      const q = quoteIssue(s, issueGpu, nowSec);
      if (q === null) issueGpu = 0n;
      else {
        base = q.base;
        fee = q.fee;
        total = q.total;
      }
    } else {
      issueGpu = 0n;
    }
  }
  return { polGpu, polSpend, polFee, issueGpu, base, fee, total };
}

/** GPUHook._supplyForGrossBudget — the largest supply whose gross draw
 *  (supply + polFee + hookFee) stays within budget. The initial estimate
 *  overshoots by at most the two ceil-rounding wei; fees are non-decreasing
 *  in the supply, so one exact shrink step lands inside — bounded loop. */
export function supplyForGrossBudget(budget: bigint, polFeeBps: number, hookFeeBps: number): bigint {
  if (budget === 0n) return 0n;
  const spread = BigInt(polFeeBps + hookFeeBps);
  let supply = mulDivFloor(budget, 10_000n, 10_000n + spread);
  for (let i = 0; i < 4; ++i) {
    const gross =
      supply +
      mulDivCeil(supply, BigInt(polFeeBps), 10_000n) +
      mulDivCeil(supply, BigInt(hookFeeBps), 10_000n);
    if (gross <= budget) break;
    const over = gross - budget;
    supply = over >= supply ? 0n : supply - over;
  }
  return supply;
}

/** Buy, exact-out (the size-first desk): units demanded → gUSD spent.
 *  Mirrors _settleBuyOut/_plan: the hook supplies the whole demand (POL
 *  ask, then the backstop), the charge is ask-priced with polFee taken
 *  OUT of polSpend (the vault nets it), and the hook fee rides on top. */
export function quoteBuyExactOutMirror(
  s: HookMarketState,
  sizeRaw: bigint,
  nowSec: number,
): MirrorResult {
  if (!oracleGuardOk(s, nowSec)) return { ok: false, reason: "oracle-stale" };
  const effAsk = effAskBps(s);
  const denomAsk = s.rawPrice * BigInt(10_000 + effAsk);
  const capLeft = polCapLeft(s);
  const capGpu = capLeft === 0n ? 0n : mulDivFloor(capLeft, 10n ** 20n, denomAsk);
  const polGpu = minBig(sizeRaw, s.askInventoryGpu, capGpu);
  const polSpend = mulDivCeil(polGpu * denomAsk, 1n, 10n ** 20n);
  const polFee = mulDivCeil(polSpend, BigInt(s.polFeeBps), 10_000n);
  const issueGpu = sizeRaw - polGpu;
  let base = 0n;
  let fee = 0n;
  let charge = polSpend;
  if (issueGpu > 0n) {
    // _settleBuyOut quotes the backstop unguarded (deterministic recompute
    // == plan); the PLAN side wraps the same quote in try/catch and reverts
    // InsufficientMarketCapacity when it fails — mirrored as a rejection.
    if (!s.issuanceEnabled) {
      if (issueGpu > GPU_DUST) return { ok: false, reason: "no-ask-capacity", capacityRaw: polGpu };
    } else {
      const q = quoteIssue(s, issueGpu, nowSec);
      if (q === null) {
        // Issuance's guard failed (closed or stale) — the hook's try/catch
        // degrades the backstop leg to zero; the residual then exceeds the
        // 1-wei dust and the swap reverts InsufficientMarketCapacity.
        return { ok: false, reason: "no-ask-capacity", capacityRaw: polGpu };
      }
      base = q.base;
      fee = q.fee;
      charge = polSpend + q.total;
    }
  }
  const hookFee = mulDivCeil(charge, BigInt(s.hookFeeBps), 10_000n);
  return {
    ok: true,
    r: {
      isBuy: true,
      exactIn: false,
      gusdIn: charge + hookFee,
      gusdOut: 0n,
      gpuIn: 0n,
      gpuOut: sizeRaw,
      polGpu,
      backstopGpu: issueGpu,
      polFeeGusd: polFee,
      hookFeeGusd: hookFee,
      issueBase: base,
      issueFee: fee,
    },
  };
}

/** Buy, exact-in (the money-first desk): typed gUSD spent → gross units.
 *  Mirrors _settleBuyIn: the hook fee comes off the top of the absorbed
 *  budget (the specified delta is frozen, so the fee must ride inside it);
 *  the buyer still receives the full gross fills. The plan never reverts
 *  on capacity for this shape — the ladder fills what the fee-net budget
 *  affords — so a zero fill (dry ask + closed backstop) is the only
 *  rejection, matching the router's minOut guard. */
export function quoteBuyMirror(
  s: HookMarketState,
  spendRaw: bigint,
  nowSec: number,
): MirrorResult {
  if (!oracleGuardOk(s, nowSec)) return { ok: false, reason: "oracle-stale" };
  let hookFee = mulDivCeil(spendRaw, BigInt(s.hookFeeBps), 10_000n);
  if (hookFee > spendRaw) hookFee = spendRaw;
  const budget = spendRaw - hookFee;
  const ladder = buyLadder(s, budget, 2n ** 256n - 1n, nowSec);
  const grossGpu = ladder.polGpu + ladder.issueGpu;
  if (grossGpu === 0n) return { ok: false, reason: "no-ask-capacity", capacityRaw: 0n };
  return {
    ok: true,
    r: {
      isBuy: true,
      exactIn: true,
      gusdIn: spendRaw,
      gusdOut: 0n,
      gpuIn: 0n,
      gpuOut: grossGpu,
      polGpu: ladder.polGpu,
      backstopGpu: ladder.issueGpu,
      polFeeGusd: ladder.polFee,
      hookFeeGusd: hookFee,
      issueBase: ladder.base,
      issueFee: ladder.fee,
    },
  };
}

/** Sell, exact-in (every sell shape's execution): units sold → net gUSD.
 *  Mirrors _settleSellIn/_plan: bid inventory at the bid edge, POL fee then
 *  hook fee off the top; a residual the bid book can't absorb beyond one
 *  GPU-wei of dust reverts InsufficientMarketCapacity (no LPs beyond the
 *  edge in this configuration) — mirrored as a capacity rejection carrying
 *  the max-sellable size. */
export function quoteSellMirror(
  s: HookMarketState,
  sizeRaw: bigint,
  nowSec: number,
): MirrorResult {
  if (!oracleGuardOk(s, nowSec)) return { ok: false, reason: "oracle-stale" };
  const bidDenom = s.rawPrice * BigInt(10_000 - s.bidBps);
  if (bidDenom === 0n) return { ok: false, reason: "no-bid-capacity", capacityRaw: 0n };
  const capLeft = polCapLeft(s);
  const capGpu = capLeft === 0n ? 0n : mulDivFloor(capLeft, 10n ** 20n, bidDenom);
  const expressible = mulDivFloor(s.bidInventoryGusd, 10n ** 20n, bidDenom);
  const capacity = minBig(expressible, capGpu);
  const polGpu = minBig(sizeRaw, expressible, capGpu);
  const residual = sizeRaw - polGpu;
  if (residual > GPU_DUST) {
    return { ok: false, reason: "no-bid-capacity", capacityRaw: capacity };
  }
  // residual ≤ GPU_DUST: the vault absorbs the tail GPU (unpaid) so the
  // ledger closes; the seller is paid for the expressible fill only.
  const gross = mulDivFloor(polGpu * bidDenom, 1n, 10n ** 20n);
  const polFee = mulDivCeil(gross, BigInt(s.polFeeBps), 10_000n);
  const net = gross - polFee;
  const hookFee = mulDivCeil(net, BigInt(s.hookFeeBps), 10_000n);
  return {
    ok: true,
    r: {
      isBuy: false,
      exactIn: true,
      gusdIn: 0n,
      gusdOut: net - hookFee,
      gpuIn: sizeRaw,
      gpuOut: 0n,
      polGpu,
      backstopGpu: 0n,
      polFeeGusd: polFee,
      hookFeeGusd: hookFee,
      issueBase: 0n,
      issueFee: 0n,
    },
  };
}

/** Sell, exact-out gUSD (the money-first desk): proceeds demanded → gross
 *  units to sell. Mirrors _plan/_settleSellOut: the seller bears both fees
 *  through the absorb price (gross = supply + fees, priced at the bid) and
 *  the commit's supply cap keeps every fill inside the bid book. The
 *  PM's physical-GPU budget leg is excluded — the router pre-settles the
 *  seller's input, so it never binds a quoted trade. */
export function quoteSellExactOutMirror(
  s: HookMarketState,
  proceedsRaw: bigint,
  nowSec: number,
): MirrorResult {
  if (!oracleGuardOk(s, nowSec)) return { ok: false, reason: "oracle-stale" };
  const bidDenom = s.rawPrice * BigInt(10_000 - s.bidBps);
  const capLeft = polCapLeft(s);
  // Budget = vault float ∩ R10 cap (L445-448, without the PM leg).
  const budget = minBig(s.bidInventoryGusd, capLeft);
  const supplyCap = supplyForGrossBudget(budget, s.polFeeBps, s.hookFeeBps);
  const supply = minBig(proceedsRaw, supplyCap);
  const residual = proceedsRaw - supply;
  if (residual > GUSD_DUST) {
    return { ok: false, reason: "no-bid-capacity", capacityRaw: supplyCap };
  }
  const polFee = mulDivCeil(supply, BigInt(s.polFeeBps), 10_000n);
  const hookFee = mulDivCeil(supply, BigInt(s.hookFeeBps), 10_000n);
  const gross = supply + polFee + hookFee;
  const gpuAbs = bidDenom === 0n ? 0n : mulDivCeil(gross, 10n ** 20n, bidDenom);
  return {
    ok: true,
    r: {
      isBuy: false,
      exactIn: false,
      gusdIn: 0n,
      gusdOut: supply,
      gpuIn: gpuAbs,
      gpuOut: 0n,
      polGpu: gpuAbs,
      backstopGpu: 0n,
      polFeeGusd: polFee,
      hookFeeGusd: hookFee,
      issueBase: 0n,
      issueFee: 0n,
    },
  };
}

/** The bid book's capacity — the numbers the slip's MAX and its
 *  capacity-exceeded gate quote. maxUnitsRaw feeds the units-first desk,
 *  maxProceedsRaw the money-first desk. */
export function sellCapacityMirror(
  s: HookMarketState,
  nowSec: number,
): { maxUnitsRaw: bigint; maxProceedsRaw: bigint } {
  if (!oracleGuardOk(s, nowSec)) return { maxUnitsRaw: 0n, maxProceedsRaw: 0n };
  const bidDenom = s.rawPrice * BigInt(10_000 - s.bidBps);
  if (bidDenom === 0n) return { maxUnitsRaw: 0n, maxProceedsRaw: 0n };
  const capLeft = polCapLeft(s);
  const expressible = mulDivFloor(s.bidInventoryGusd, 10n ** 20n, bidDenom);
  const capGpu = capLeft === 0n ? 0n : mulDivFloor(capLeft, 10n ** 20n, bidDenom);
  const maxUnitsRaw = minBig(expressible, capGpu);
  const maxProceedsRaw = supplyForGrossBudget(minBig(s.bidInventoryGusd, capLeft), s.polFeeBps, s.hookFeeBps);
  return { maxUnitsRaw, maxProceedsRaw };
}

function minBig(...values: bigint[]): bigint {
  let m = values[0] as bigint;
  for (let i = 1; i < values.length; ++i) {
    const v = values[i] as bigint;
    if (v < m) m = v;
  }
  return m;
}
