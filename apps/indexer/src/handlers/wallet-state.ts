/**
 * Wallet-state write helpers — the DB legs of the balance / cost-basis /
 * vault projections (pure math in src/projections/cost-basis.ts). Every
 * helper is read-then-write inside Ponder's per-event transaction: handlers
 * run sequentially per chain and reorg replay re-runs them over rolled-back
 * state, so the absolute rewrites converge (same pattern as the pools
 * counters).
 */
import type { Address, Hex } from "viem";
import {
  walletBalances,
  walletCostBasis,
  walletVaultPositions,
} from "ponder:schema";
import { ZERO_ADDRESS } from "../projections/balances.js";
import {
  acquireBasis,
  demoteBasis,
  demoteVault,
  depositVault,
  disposeBasis,
  emptyBasis,
  emptyVault,
  withdrawVault,
  type BasisSnapshot,
  type BasisState,
  type VaultSnapshot,
} from "../projections/cost-basis.js";
import type { EventKeys } from "../events.js";

/**
 * Minimal structural view of Ponder's context.db — what these helpers need,
 * no more, so call sites pass context.db straight through.
 *
 * find's return is deliberately loose: Ponder's `Find` is a single generic
 * signature, and checking it against specific interface overloads
 * instantiates the select model to an open record. Strong typing lives in
 * the pure projections (cost-basis.ts); reads here cast the fields they
 * consume, mirroring what the DB actually stores.
 */
interface WalletStateDb {
  find(
    table: typeof walletBalances,
    key: { chainId: number; wallet: Address; token: Address },
  ): Promise<{ [column: string]: any } | null>;
  find(
    table: typeof walletCostBasis,
    key: { chainId: number; wallet: Address; gpuId: Hex },
  ): Promise<{ [column: string]: any } | null>;
  find(
    table: typeof walletVaultPositions,
    key: { chainId: number; wallet: Address },
  ): Promise<{ [column: string]: any } | null>;
  insert(table: typeof walletBalances): {
    values(value: typeof walletBalances.$inferInsert): {
      onConflictDoUpdate(
        set: Partial<typeof walletBalances.$inferInsert>,
      ): Promise<unknown>;
    };
  };
  insert(table: typeof walletCostBasis): {
    values(value: typeof walletCostBasis.$inferInsert): {
      onConflictDoUpdate(
        set: Partial<typeof walletCostBasis.$inferInsert>,
      ): Promise<unknown>;
    };
  };
  insert(table: typeof walletVaultPositions): {
    values(value: typeof walletVaultPositions.$inferInsert): {
      onConflictDoUpdate(
        set: Partial<typeof walletVaultPositions.$inferInsert>,
      ): Promise<unknown>;
    };
  };
}

/** The DB enum carries "unknown" (API display for never-attributable
 *  state), but the indexer only ever writes complete|partial — any foreign
 *  value is treated as non-attributable, the safe side of the gate. */
function asBasisState(value: unknown): BasisState {
  return value === "complete" ? "complete" : "partial";
}

/** The protocol contract addresses registered in ponder.config — the set a
 *  raw transfer must avoid on BOTH sides to count as a user-to-user move
 *  (and thus demote basis). Anything from/to a protocol contract is a
 *  protocol flow (PM-held pool liquidity, router forwarding, issuance
 *  mint, vault mint/burn), never a demotion. GPUToken's config address is
 *  a Factory object, not an address — runtime narrowing skips it. */
export function protocolContractAddresses(context: {
  contracts: object;
}): Set<string> {
  const set = new Set<string>([ZERO_ADDRESS]);
  for (const contract of Object.values(context.contracts)) {
    const address = (contract as { address?: unknown }).address;
    if (address === undefined) continue;
    if (typeof address === "string") {
      set.add(address.toLowerCase());
    } else if (Array.isArray(address)) {
      for (const a of address) {
        if (typeof a === "string") set.add(a.toLowerCase());
      }
    }
  }
  return set;
}

/** True when the address is NOT zero/protocol — only wallet↔wallet moves
 *  demote basis. */
export function isUserWallet(address: string, contracts: Set<string>): boolean {
  return !contracts.has(address.toLowerCase());
}

// --- balances ---------------------------------------------------------------

/** Apply one signed transfer delta to (chainId, wallet, token). A negative
 *  delta below zero is a loud invariant break (a wallet cannot send tokens
 *  it never received — under Ponder's sequential, per-event processing
 *  this means the projections diverged and indexing must stop). */
export async function applyBalanceDelta(
  db: WalletStateDb,
  keys: EventKeys,
  token: Address,
  wallet: Address,
  delta: bigint,
): Promise<void> {
  const row = await db.find(walletBalances, {
    chainId: keys.chainId,
    wallet,
    token,
  });
  const previous = (row?.balance as bigint | undefined) ?? 0n;
  const balance = previous + delta;
  if (balance < 0n) {
    throw new Error(
      `wallet_balances underflow for ${wallet} token ${token} at block ${keys.blockNumber}: ${previous.toString()} + ${delta.toString()}`,
    );
  }
  const transferCount = ((row?.transferCount as number | undefined) ?? 0) + 1;
  await db
    .insert(walletBalances)
    .values({
      chainId: keys.chainId,
      wallet,
      token,
      balance,
      transferCount,
      lastTransferAtSec: keys.blockTimestamp,
      lastTransferBlockNumber: keys.blockNumber,
    })
    .onConflictDoUpdate({
      balance,
      transferCount,
      lastTransferAtSec: keys.blockTimestamp,
      lastTransferBlockNumber: keys.blockNumber,
    });
}

// --- GPU cost basis ---------------------------------------------------------

async function updateBasis(
  db: WalletStateDb,
  keys: EventKeys,
  wallet: Address,
  gpuId: Hex,
  step: (b: BasisSnapshot) => BasisSnapshot,
): Promise<void> {
  const row = await db.find(walletCostBasis, {
    chainId: keys.chainId,
    wallet,
    gpuId,
  });
  const current: BasisSnapshot =
    row === null || row === undefined
      ? emptyBasis()
      : {
          qtyGpu: row.qtyGpu as bigint,
          costGusd: row.costGusd as bigint,
          realizedPnlGusd: row.realizedPnlGusd as bigint,
          basisState: asBasisState(row.basisState),
          acquisitions: row.acquisitions as number,
          disposals: row.disposals as number,
        };
  const next = step(current);
  await db
    .insert(walletCostBasis)
    .values({
      chainId: keys.chainId,
      wallet,
      gpuId,
      qtyGpu: next.qtyGpu,
      costGusd: next.costGusd,
      realizedPnlGusd: next.realizedPnlGusd,
      basisState: next.basisState,
      acquisitions: next.acquisitions,
      disposals: next.disposals,
      firstActivityAtSec:
        (row?.firstActivityAtSec as number | undefined) ?? keys.blockTimestamp,
      lastActivityAtSec: keys.blockTimestamp,
    })
    .onConflictDoUpdate({
      qtyGpu: next.qtyGpu,
      costGusd: next.costGusd,
      realizedPnlGusd: next.realizedPnlGusd,
      basisState: next.basisState,
      acquisitions: next.acquisitions,
      disposals: next.disposals,
      lastActivityAtSec: keys.blockTimestamp,
    });
}

/** Protocol acquisition of qty GPU for total cost (gUSD raw). */
export async function recordGpuAcquisition(
  db: WalletStateDb,
  keys: EventKeys,
  wallet: Address,
  gpuId: Hex,
  qty: bigint,
  cost: bigint,
): Promise<void> {
  await updateBasis(db, keys, wallet, gpuId, (b) => acquireBasis(b, qty, cost));
}

/** Protocol disposal of qty GPU for proceeds (gUSD-equivalent raw). */
export async function recordGpuDisposal(
  db: WalletStateDb,
  keys: EventKeys,
  wallet: Address,
  gpuId: Hex,
  qty: bigint,
  proceeds: bigint,
): Promise<void> {
  await updateBasis(db, keys, wallet, gpuId, (b) =>
    disposeBasis(b, qty, proceeds),
  );
}

/** A raw GPUToken transfer touched this wallet — demote, never mutate. */
export async function demoteGpuBasis(
  db: WalletStateDb,
  keys: EventKeys,
  wallet: Address,
  gpuId: Hex,
): Promise<void> {
  await updateBasis(db, keys, wallet, gpuId, demoteBasis);
}

// --- sgUSD vault position ---------------------------------------------------

async function updateVault(
  db: WalletStateDb,
  keys: EventKeys,
  wallet: Address,
  step: (v: VaultSnapshot) => VaultSnapshot,
): Promise<void> {
  const row = await db.find(walletVaultPositions, {
    chainId: keys.chainId,
    wallet,
  });
  const current: VaultSnapshot =
    row === null || row === undefined
      ? emptyVault()
      : {
          shares: row.shares as bigint,
          assetsCost: row.assetsCost as bigint,
          realizedPnlGusd: row.realizedPnlGusd as bigint,
          basisState: asBasisState(row.basisState),
          deposits: row.deposits as number,
          withdraws: row.withdraws as number,
        };
  const next = step(current);
  await db
    .insert(walletVaultPositions)
    .values({
      chainId: keys.chainId,
      wallet,
      shares: next.shares,
      assetsCost: next.assetsCost,
      realizedPnlGusd: next.realizedPnlGusd,
      basisState: next.basisState,
      deposits: next.deposits,
      withdraws: next.withdraws,
      firstActivityAtSec:
        (row?.firstActivityAtSec as number | undefined) ?? keys.blockTimestamp,
      lastActivityAtSec: keys.blockTimestamp,
    })
    .onConflictDoUpdate({
      shares: next.shares,
      assetsCost: next.assetsCost,
      realizedPnlGusd: next.realizedPnlGusd,
      basisState: next.basisState,
      deposits: next.deposits,
      withdraws: next.withdraws,
      lastActivityAtSec: keys.blockTimestamp,
    });
}

export async function recordVaultDeposit(
  db: WalletStateDb,
  keys: EventKeys,
  wallet: Address,
  assets: bigint,
  shares: bigint,
): Promise<void> {
  await updateVault(db, keys, wallet, (v) => depositVault(v, assets, shares));
}

export async function recordVaultWithdraw(
  db: WalletStateDb,
  keys: EventKeys,
  wallet: Address,
  assets: bigint,
  shares: bigint,
): Promise<void> {
  await updateVault(db, keys, wallet, (v) => withdrawVault(v, assets, shares));
}

/** A raw sgUSD share transfer touched this wallet — demote, never mutate. */
export async function demoteVaultPosition(
  db: WalletStateDb,
  keys: EventKeys,
  wallet: Address,
): Promise<void> {
  await updateVault(db, keys, wallet, demoteVault);
}
