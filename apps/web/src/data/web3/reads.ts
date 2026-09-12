/**
 * Contract reads for execution support and correctness — the interim user-
 * state source when indexed data is unavailable (see src/domain/indexer.ts).
 * Balances, allowances, registration, and preview/state views the action
 * layer needs immediately before execution. Never a market-data source: no
 * prices, no candles, no volume (doctrine in ./public-client).
 */

import type { Address } from "viem";
import { getContracts, gpuTokenClient, erc20Client } from "./contracts";
import { poolIdOf, canonicalPoolKey } from "./pool";
import { formatGusdRaw, formatStableRaw, formatGpuUnits } from "@/domain/units";
import type { HookMarketState } from "./trading/hook-quote";

/** Onchain registration state of one market — the single source for
 *  "unavailable" UI states. Null when the GPU isn't registered at all. */
export interface GpuRegistration {
  gpuId: `0x${string}`;
  token: Address;
  issuanceEnabled: boolean;
  poolRegistered: boolean;
  poolParams: { fee: number; tickSpacing: number };
  /** This market's primary issuance fee, bps. */
  issuanceFeeBps: number;
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
  /** gUSD / reserve-asset / sgUSD balances in one batch, product units. */
  balances(owner: Address): Promise<{ gUsd: number; stable: number; sGusd: number }>;
  /** GPU positions across every registered gpuId (18-decimal raw + product).
   *  The basis fields arrive only from the indexed seam (cost basis is an
   *  indexer capability): the direct-RPC implementation leaves them
   *  undefined, which maps to null — "—" — downstream. Raw gUSD strings. */
  positions(owner: Address): Promise<
    Array<{
      gpuId: `0x${string}`;
      token: Address;
      raw: bigint;
      size: number;
      /** gUSD (6-dec raw) per whole GPU — null unless basis is complete. */
      avgEntryRaw?: string | null;
      /** Realized PnL, gUSD 6-dec raw — null unless basis is complete. */
      realizedPnlGusdRaw?: string | null;
      basisState?: string | null;
      /** The gate reason when a basis field is null, verbatim. */
      basisReason?: string | null;
    }>
  >;
  /** Market registration state (token, issuance gate, pool). */
  registration(gpuId: `0x${string}`): Promise<GpuRegistration | null>;
  /** Issuance quote: base, fee, total — gUSD product units. */
  quoteIssue(gpuId: `0x${string}`, amountRaw: bigint): Promise<{ base: number; fee: number; totalPaid: number }>;
  /** GUSD fee + pause state (pause blocks mint/redeem and reserve-paid legs). */
  gusdState(): Promise<GusdState>;
  /** Vault share price + caps for one owner. */
  sgusdState(owner: Address): Promise<SGusdState>;
  /** Protocol trading fee, bps (display + sell net math). */
  hookFeeBps(): Promise<number>;
  /** Oracle freshness for a market (execution input; never a display price).
   *  `rawPrice` is the oracle's own 4-decimal fixed point (product price ×
   *  10_000) — the scale issuance's math runs at. Staleness judged by
   *  issuance's own limit — the constraint issue() enforces. */
  oracleUpdatedAt(gpuId: `0x${string}`): Promise<{ rawPrice: bigint; updatedAt: number; isStale: boolean }>;
  /** The hook's full plan-input state for one market, in one batch — the
   *  deterministic quoter's input set (see trading/hook-quote.ts). Every
   *  field is a public view; the per-block POL usage has no getter and is
   *  structurally 0 at quote time (a landing tx's block starts fresh). */
  hookMarketState(gpuId: `0x${string}`): Promise<HookMarketState>;
}

/**
 * Batched contract reads over the memoized contract set. Batching happens
 * in the http transport (16ms wait), so Promise.all groups stay in one
 * round trip on multi-call flows.
 */
export function contractReads(): ContractReads {
  const { gusd, stable, sgusd, issuance, hook, oracle, marketLiquidity, addresses } = getContracts();
  const ZERO = "0x0000000000000000000000000000000000000000" as Address;

  return {
    async balanceOf(token, owner) {
      return erc20Client(token).read.balanceOf([owner]);
    },
    async allowance(token, owner, spender) {
      return erc20Client(token).read.allowance([owner, spender]);
    },
    async balances(owner) {
      const [gUsdRaw, stableRaw, sGusdRaw] = await Promise.all([
        gusd.read.balanceOf([owner]),
        stable.read.balanceOf([owner]),
        sgusd.read.balanceOf([owner]),
      ]);
      return {
        gUsd: formatGusdRaw(gUsdRaw),
        stable: formatStableRaw(stableRaw),
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
      // One config read carries everything the gate and fee schedule need.
      const cfg = await issuance.read.gpuConfig([gpuId]);
      const token = cfg.token;
      if (token === ZERO) return null;
      const params = { fee: Number(cfg.fee), tickSpacing: Number(cfg.tickSpacing) };
      const key = canonicalPoolKey(addresses.gusd as Address, token, params, addresses.hook as Address);
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
        issuanceEnabled: cfg.enabled,
        poolRegistered,
        poolParams: params,
        issuanceFeeBps: Number(cfg.feeBps),
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
        rawPrice,
        updatedAt: Number(updatedAtRaw),
        isStale: rawPrice === 0n || age > Number(maxStaleness),
      };
    },
    async hookMarketState(gpuId) {
      const [polState, polPaused, maxPol, perBlockCap, hookStaleness, hookFee, getPrice, issueCfg, issueStaleness, cd, bidInv, askInv] =
        await Promise.all([
          hook.read.polState([gpuId]),
          hook.read.polPaused(),
          hook.read.maxPolNotionalGusd(),
          hook.read.perBlockPolCapGusd(),
          hook.read.maxOracleStaleness(),
          hook.read.hookFeeBps(),
          oracle.read.getPrice([gpuId]),
          issuance.read.gpuConfig([gpuId]),
          issuance.read.maxOracleStaleness(),
          issuance.read.compositionDivisor(),
          marketLiquidity.read.bidInventoryGusd([gpuId]),
          marketLiquidity.read.askInventoryGpu([gpuId]),
        ]);
      const [rawPrice, updatedAtRaw] = getPrice;
      const [askBps, bidBps, polFeeBps] = polState;
      return {
        rawPrice,
        oracleUpdatedAtSec: Number(updatedAtRaw),
        hookMaxOracleStalenessSec: Number(hookStaleness),
        askBps: Number(askBps),
        bidBps: Number(bidBps),
        polFeeBps: Number(polFeeBps),
        polPaused,
        maxPolNotionalGusd: maxPol,
        perBlockPolCapGusd: perBlockCap,
        perBlockUsedGusd: 0n, // internal mapping, no getter — fresh every landing block
        hookFeeBps: Number(hookFee),
        issueFeeBps: Number(issueCfg.feeBps),
        issuanceEnabled: issueCfg.enabled,
        issuanceMaxOracleStalenessSec: Number(issueStaleness),
        compositionDivisor: cd,
        bidInventoryGusd: bidInv,
        askInventoryGpu: askInv,
      };
    },
  };
}
