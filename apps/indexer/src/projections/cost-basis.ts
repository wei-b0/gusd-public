/**
 * Pure WAC (weighted-average-cost) math for the transfer-aware cost basis
 * (rev 2). No DB, no wall clock — handlers read the row, apply the pure
 * step, write the absolute result; reorg replay re-runs the same sequence
 * over rolled-back state, so it converges.
 *
 * V1 policy (pinned):
 *  - acquisitions = Issued (cost = base + fee, ONLY when the caller is not
 *    the router — a router Buy emits its own Issued and acquires via Buy,
 *    so counting both would double-count the issuance leg) + Buy (cost =
 *    all-in paid);
 *  - disposals = Sell (out treated gUSD-equivalent, 6-dec 1:1);
 *  - raw transfers NEVER move basis — they demote basisState to "partial",
 *    which the API turns into null avgEntry/PnL (print "—" rather than
 *    precise wrong math);
 *  - basisState is monotone: complete → partial, never back;
 *  - realized PnL only moves in complete state — disposing units whose cost
 *    is unattributable invents zero-cost disposal, which is banned;
 *    everything is deterministic floor-division integer math on raw units
 *    (GPU 18-dec, gUSD 6-dec).
 */

export type BasisState = "complete" | "partial";

export interface BasisSnapshot {
  qtyGpu: bigint;
  costGusd: bigint;
  realizedPnlGusd: bigint;
  basisState: BasisState;
  acquisitions: number;
  disposals: number;
}

export function emptyBasis(): BasisSnapshot {
  return {
    qtyGpu: 0n,
    costGusd: 0n,
    realizedPnlGusd: 0n,
    basisState: "complete",
    acquisitions: 0,
    disposals: 0,
  };
}

/** floor(a × b / denom) for non-negative bigints — bigint division truncates
 *  toward zero, which IS the floor here. Deterministic across replays. */
export function mulDivFloor(a: bigint, b: bigint, denom: bigint): bigint {
  if (denom === 0n) return 0n;
  return (a * b) / denom;
}

/** Acquire qty GPU at total cost costGusd. */
export function acquireBasis(
  b: BasisSnapshot,
  qty: bigint,
  cost: bigint,
): BasisSnapshot {
  return {
    ...b,
    qtyGpu: b.qtyGpu + qty,
    costGusd: b.costGusd + cost,
    acquisitions: b.acquisitions + 1,
  };
}

/** Dispose qty GPU for proceeds (gUSD-equivalent). Realized PnL moves only
 *  in complete state, where balance and basis agree by construction, so the
 *  disposed units are fully attributable. */
export function disposeBasis(
  b: BasisSnapshot,
  qty: bigint,
  proceeds: bigint,
): BasisSnapshot {
  const disposals = b.disposals + 1;
  if (b.basisState !== "complete" || b.qtyGpu === 0n) {
    return { ...b, disposals };
  }
  const take = qty >= b.qtyGpu ? b.qtyGpu : qty;
  const attributed = mulDivFloor(b.costGusd, take, b.qtyGpu);
  return {
    ...b,
    qtyGpu: b.qtyGpu - take,
    costGusd: b.costGusd - attributed,
    realizedPnlGusd: b.realizedPnlGusd + proceeds - attributed,
    disposals,
  };
}

/** A raw transfer touched this wallet+GPU: nothing moves, completeness is
 *  lost. Materializes a zero-qty partial row when the wallet had no basis
 *  yet — a transfer-in means unattributable units exist from now on. */
export function demoteBasis(b: BasisSnapshot): BasisSnapshot {
  return { ...b, basisState: "partial" };
}

// --- sgUSD vault position ---------------------------------------------------

export interface VaultSnapshot {
  shares: bigint;
  assetsCost: bigint;
  realizedPnlGusd: bigint;
  basisState: BasisState;
  deposits: number;
  withdraws: number;
}

export function emptyVault(): VaultSnapshot {
  return {
    shares: 0n,
    assetsCost: 0n,
    realizedPnlGusd: 0n,
    basisState: "complete",
    deposits: 0,
    withdraws: 0,
  };
}

/** Deposit assets for shares — cost basis in asset (gUSD) terms. */
export function depositVault(
  v: VaultSnapshot,
  assets: bigint,
  shares: bigint,
): VaultSnapshot {
  return {
    ...v,
    shares: v.shares + shares,
    assetsCost: v.assetsCost + assets,
    deposits: v.deposits + 1,
  };
}

/** Withdraw (burn sharesBurned, receive assetsOut): realize against the
 *  average cost of the burned shares, same completeness gate as GPU basis. */
export function withdrawVault(
  v: VaultSnapshot,
  assetsOut: bigint,
  sharesBurned: bigint,
): VaultSnapshot {
  const withdraws = v.withdraws + 1;
  if (v.basisState !== "complete" || v.shares === 0n) {
    return {
      ...v,
      shares: v.shares >= sharesBurned ? v.shares - sharesBurned : 0n,
      withdraws,
    };
  }
  const take = sharesBurned >= v.shares ? v.shares : sharesBurned;
  const costBurned = mulDivFloor(v.assetsCost, take, v.shares);
  return {
    ...v,
    shares: v.shares - take,
    assetsCost: v.assetsCost - costBurned,
    realizedPnlGusd: v.realizedPnlGusd + assetsOut - costBurned,
    withdraws,
  };
}

/** A raw sgUSD share transfer touched this wallet: demote. */
export function demoteVault(v: VaultSnapshot): VaultSnapshot {
  return { ...v, basisState: "partial" };
}
