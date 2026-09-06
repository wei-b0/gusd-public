/**
 * Contract reads for execution support and correctness — the interim user-
 * state source until the Ponder indexer ships (see src/domain/indexer.ts).
 * Balances, allowances, registration, and preview/state views the action
 * layer needs immediately before execution. Never a market-data source: no
 * prices, no candles, no volume (doctrine in ./public-client).
 */

import type { Address } from "viem";
import { getContracts, gpuTokenClient, erc20Client } from "./contracts";
import { poolIdOf, canonicalPoolKey } from "./pool";
import { formatGusdRaw, formatUsdcRaw, formatGpuUnits } from "@/domain/units";

/** Onchain registration state of one market — the single source for
 *  "unavailable" UI states. Null when the GPU isn't registered at all. */
export interface GpuRegistration {
  gpuId: `0x${string}`;
  token: Address;
  issuanceEnabled: boolean;
  poolRegistered: boolean;
  poolParams: { fee: number; tickSpacing: number };
}

export interface GusdState {
  mintFeeBps: number;
  redeemFeeBps: number;
  paused: boolean;
}

export interface SGusdState {
  /** gUSD per 1 sgUSD (product units). */
  rate: number;
  seeded: boolean;
  maxDeposit: bigint;
  maxWithdraw: bigint;
}

export interface ContractReads {
  /** ERC-20 balance in raw units — comparisons happen in raw; convert with
   *  the units module per token flavor. */
  balanceOf(token: Address, owner: Address): Promise<bigint>;
  /** ERC-20 allowance, raw bigint. */
  allowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  /** gUSD / USDC / sgUSD balances in one batch, product units. */
  balances(owner: Address): Promise<{ gUsd: number; usdc: number; sGusd: number }>;
  /** GPU positions across every registered gpuId (18-decimal raw + product). */
  positions(owner: Address): Promise<Array<{ gpuId: `0x${string}`; token: Address; raw: bigint; size: number }>>;
  /** Market registration state (token, issuance gate, pool). */
  registration(gpuId: `0x${string}`): Promise<GpuRegistration | null>;
  /** Issuance quote: base, fee, total — gUSD product units. */
  quoteIssue(gpuId: `0x${string}`, amountRaw: bigint): Promise<{ base: number; fee: number; totalPaid: number }>;
  /** GUSD fee + pause state (pause blocks mint/redeem and USDC-paid legs). */
  gusdState(): Promise<GusdState>;
  /** Vault share price + caps for one owner. */
  sgusdState(owner: Address): Promise<SGusdState>;
  /** Protocol trading fee, bps (display + sell net math). */
  hookFeeBps(): Promise<number>;
  /** Oracle freshness for a market (execution input; never a display price).
   *  Staleness judged by issuance's own limit — the constraint issue() enforces. */
  oracleUpdatedAt(gpuId: `0x${string}`): Promise<{ price: number; updatedAt: number; isStale: boolean }>;
}

/**
 * Batched contract reads over the memoized contract set. Batching happens
 * in the http transport (16ms wait), so Promise.all groups stay in one
 * round trip on multi-call flows.
 */
export function contractReads(): ContractReads {
  const { gusd, usdc, sgusd, issuance, hook, oracle, addresses } = getContracts();
  const ZERO = "0x0000000000000000000000000000000000000000" as Address;

  return {
    async balanceOf(token, owner) {
      return erc20Client(token).read.balanceOf([owner]);
    },
    async allowance(token, owner, spender) {
      return erc20Client(token).read.allowance([owner, spender]);
    },
    async balances(owner) {
      const [gUsdRaw, usdcRaw, sGusdRaw] = await Promise.all([
        gusd.read.balanceOf([owner]),
        usdc.read.balanceOf([owner]),
        sgusd.read.balanceOf([owner]),
      ]);
      return {
        gUsd: formatGusdRaw(gUsdRaw),
        usdc: formatUsdcRaw(usdcRaw),
        sGusd: formatGusdRaw(sGusdRaw),
      };
    },
    async positions(owner) {
      const gpuIds = await issuance.read.gpuIds();
      const entries = await Promise.all(
        gpuIds.map(async (gpuId) => {
          const token = await issuance.read.tokenOf([gpuId]);
          if (token === ZERO) return null;
          const raw = await gpuTokenClient(token).read.balanceOf([owner]);
          if (raw === 0n) return null;
          return { gpuId, token, raw, size: formatGpuUnits(raw) };
        }),
      );
      return entries.filter((e): e is NonNullable<typeof e> => e !== null);
    },
    async registration(gpuId) {
      const token = await issuance.read.tokenOf([gpuId]);
      if (token === ZERO) return null;
      const [enabled, params] = await Promise.all([
        issuance.read.isIssuanceEnabled([gpuId]),
        issuance.read.poolParamsOf([gpuId]),
      ]);
      const key = canonicalPoolKey(
        addresses.gusd as Address,
        token,
        { fee: Number(params.fee), tickSpacing: Number(params.tickSpacing) },
        addresses.hook as Address,
      );
      let poolRegistered = false;
      try {
        const registered = await hook.read.poolGpuId([poolIdOf(key)]);
        poolRegistered = registered === gpuId;
      } catch {
        poolRegistered = false;
      }
      return {
        gpuId,
        token,
        issuanceEnabled: enabled,
        poolRegistered,
        poolParams: { fee: Number(params.fee), tickSpacing: Number(params.tickSpacing) },
      };
    },
    async quoteIssue(gpuId, amountRaw) {
      const [base, fee, totalPaid] = await issuance.read.quoteIssue([gpuId, amountRaw]);
      return {
        base: formatGusdRaw(base),
        fee: formatGusdRaw(fee),
        totalPaid: formatGusdRaw(totalPaid),
      };
    },
    async gusdState() {
      const [mintFeeBps, redeemFeeBps, paused] = await Promise.all([
        gusd.read.mintFeeBps(),
        gusd.read.redeemFeeBps(),
        gusd.read.paused(),
      ]);
      return { mintFeeBps: Number(mintFeeBps), redeemFeeBps: Number(redeemFeeBps), paused };
    },
    async sgusdState(owner) {
      const [rate, seeded, maxDeposit, maxWithdraw] = await Promise.all([
        sgusd.read.convertToAssets([10n ** 6n]),
        sgusd.read.seeded(),
        sgusd.read.maxDeposit([owner]),
        sgusd.read.maxWithdraw([owner]),
      ]);
      return { rate: formatGusdRaw(rate), seeded, maxDeposit, maxWithdraw };
    },
    async hookFeeBps() {
      return Number(await hook.read.hookFeeBps());
    },
    async oracleUpdatedAt(gpuId) {
      const [getPrice, maxStaleness] = await Promise.all([
        oracle.read.getPrice([gpuId]),
        issuance.read.maxOracleStaleness(),
      ]);
      const [rawPrice, updatedAtRaw] = getPrice;
      const now = Math.floor(Date.now() / 1000);
      const age = now - Number(updatedAtRaw);
      return {
        price: formatGusdRaw(rawPrice),
        updatedAt: Number(updatedAtRaw),
        isStale: rawPrice === 0n || age > Number(maxStaleness),
      };
    },
  };
}
