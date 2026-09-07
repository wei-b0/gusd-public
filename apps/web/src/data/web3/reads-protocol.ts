/**
 * The indexed read seam: same ContractReads port, with the STATE methods
 * (balances, positions, registration, gusdState, sgusdState, hookFeeBps)
 * answered from the oracle's /v1/protocol/* routes over Ponder's indexed
 * views when NEXT_PUBLIC_INDEXER_URL is configured. Everything
 * freshness-critical or execution-adjacent stays on direct RPC exactly as
 * before: balanceOf/allowance (approvals + actions), quoteIssue (quotes),
 * oracleUpdatedAt (staleness gate), the reserve-asset balance (stables are
 * deliberately not indexed), the GUSD pause flag, the vault seed flag, and
 * the per-owner vault caps.
 *
 * Doctrine preserved (see ./public-client): indexed state is balances and
 * history only — never a price source. Any indexed fetch that fails or
 * times out falls back to the RPC implementation for that call: the
 * indexer's absence is a degradation, never an error surface.
 */

import type { Address } from "viem";
import { getContracts } from "./contracts";
import { getActiveChain } from "./chains";
import { contractReads, type ContractReads, type GpuRegistration, type SGusdState } from "./reads";
import { formatGpuUnits, formatGusdRaw } from "@/domain/units";
import type { WalletPositionDto, WalletPositionsBody } from "../protocol/dto";

/** Read lazily so tests can stub the env without import juggling. */
export function indexerUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_INDEXER_URL;
  const trimmed = raw?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : null;
}

/** An indexed read that doesn't answer within this falls back to RPC. */
const TIMEOUT_MS = 5_000;

async function fetchJson<T>(path: string): Promise<T | null> {
  const url = indexerUrl();
  if (url === null) return null;
  try {
    const res = await fetch(`${url}${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Same, but 4xx is a real answer (null) — only transport/5xx failures
 *  throw, so callers can distinguish "indexer says no" from "indexer gone". */
async function fetchJsonOrThrow<T>(path: string): Promise<T | null> {
  const url = indexerUrl();
  if (url === null) throw new Error("indexer not configured");
  const res = await fetch(`${url}${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`indexer ${path} → ${res.status}`);
  return (await res.json()) as T;
}

interface BalanceRow {
  chainId: number;
  token: string;
  balance: string;
}

interface WalletBalancesBody {
  balances: BalanceRow[];
}

interface GpuAssetBody {
  gpuId: string;
  token: string;
  issuanceEnabled: boolean;
  poolFee: number;
  tickSpacing: number;
  issuanceFeeBps: number;
  canonicalPoolId: string | null;
}

interface StatsBody {
  stats: { mintFeeBps: number | null; redeemFeeBps: number | null; hookFeeBps: number | null };
  vault: {
    seededGusd: string;
    depositsGusd: string;
    withdrawsGusd: string;
    sharesMinted: string;
    sharesBurned: string;
    revenueGusd: string;
  } | null;
}

/** The wallet's balances on the active chain, keyed by lowercase token. */
async function indexedBalances(owner: Address): Promise<Map<string, bigint>> {
  const body = await fetchJsonOrThrow<WalletBalancesBody>(
    `/wallets/${owner.toLowerCase()}/balances`,
  );
  if (body === null) return new Map();
  const chainId = getActiveChain().id;
  return new Map(
    body.balances
      .filter((r) => r.chainId === chainId)
      .map((r) => [r.token.toLowerCase(), BigInt(r.balance)]),
  );
}

export function contractReadsWithIndexer(): ContractReads {
  const rpc = contractReads();
  // Inert without the env — identical behavior to before the indexer.
  if (indexerUrl() === null) return rpc;
  const { gusd, sgusd, addresses } = getContracts();
  const gusdToken = (addresses.gusd as string).toLowerCase();
  const sgusdToken = (addresses.sgusd as string).toLowerCase();

  return {
    ...rpc,

    async balances(owner) {
      try {
        const rows = await indexedBalances(owner);
        // Reserve + share balances come from the index; the reserve ASSET
        // (non-protocol stable) stays a direct read — deliberately unindexed.
        const stableRaw = await getContracts().stable.read.balanceOf([owner]);
        const gUsdRaw = rows.get(gusdToken) ?? 0n;
        const sGusdRaw = rows.get(sgusdToken) ?? 0n;
        return {
          gUsd: formatGusdRaw(gUsdRaw),
          stable: formatGusdRaw(stableRaw),
          sGusd: formatGusdRaw(sGusdRaw),
        };
      } catch {
        return rpc.balances(owner);
      }
    },

    async positions(owner) {
      try {
        // Existence + size stay balance-derived (the balance join below is
        // the truth of what the wallet holds); the basis endpoint only
        // attaches avgEntry/realizedPnl by gpuId. A basis fetch that fails
        // degrades to null basis ("—"), never to a wrong figure.
        const [gpuList, rows, basisBody] = await Promise.all([
          fetchJson<{ gpus: GpuAssetBody[] }>("/gpus"),
          indexedBalances(owner),
          fetchJson<WalletPositionsBody>(`/wallets/${owner.toLowerCase()}/positions`),
        ]);
        if (gpuList === null) return rpc.positions(owner);
        const chainId = getActiveChain().id;
        const basisByGpu = new Map<string, WalletPositionDto>();
        if (basisBody !== null) {
          for (const p of basisBody.positions) {
            if (p.chainId === chainId) basisByGpu.set(p.gpuId.toLowerCase(), p);
          }
        }
        const entries = gpuList.gpus
          .filter((g) => (rows.get(g.token.toLowerCase()) ?? 0n) > 0n)
          .map((g) => {
            const raw = rows.get(g.token.toLowerCase())!;
            const basis = basisByGpu.get(g.gpuId.toLowerCase());
            return {
              gpuId: g.gpuId as `0x${string}`,
              token: g.token as Address,
              raw,
              size: formatGpuUnits(raw),
              avgEntryRaw: basis?.avgEntryGusd ?? null,
              realizedPnlGusdRaw: basis?.realizedPnlGusd ?? null,
              basisState: basis?.basisState ?? null,
              basisReason: basis?.reason ?? null,
            };
          });
        return entries;
      } catch {
        return rpc.positions(owner);
      }
    },

    async registration(gpuId) {
      try {
        const body = await fetchJsonOrThrow<{ gpu: GpuAssetBody }>(`/gpus/${gpuId.toLowerCase()}`);
        if (body === null) return null;
        // Registration evidence = a registered pool row for the canonical id
        // (null canonical id ⇒ never registered, no second fetch).
        const canonical = body.gpu.canonicalPoolId;
        const pool =
          canonical === null ? null : await fetchJsonOrThrow<unknown>(`/pools/${canonical}`);
        const registration: GpuRegistration = {
          gpuId,
          token: body.gpu.token as Address,
          issuanceEnabled: body.gpu.issuanceEnabled,
          poolRegistered: pool !== null,
          poolParams: { fee: body.gpu.poolFee, tickSpacing: body.gpu.tickSpacing },
          issuanceFeeBps: body.gpu.issuanceFeeBps,
        };
        return registration;
      } catch {
        return rpc.registration(gpuId);
      }
    },

    async gusdState() {
      try {
        const [body, paused] = await Promise.all([
          fetchJson<StatsBody>("/stats"),
          gusd.read.paused(),
        ]);
        if (body === null || body.stats.mintFeeBps === null || body.stats.redeemFeeBps === null) {
          return rpc.gusdState();
        }
        // The pause flag gates execution — direct read, always fresh.
        return { mintFeeBps: body.stats.mintFeeBps, redeemFeeBps: body.stats.redeemFeeBps, paused };
      } catch {
        return rpc.gusdState();
      }
    },

    async sgusdState(owner) {
      try {
        const body = await fetchJson<StatsBody>("/stats");
        if (body === null || body.vault === null) return rpc.sgusdState(owner);
        // Caps + seed flag stay direct reads; the share PRICE derives from
        // the vault aggregates (assets = seeded + deposits − withdraws +
        // revenue; shares = minted − burned). Zero shares → RPC truth.
        const assets =
          BigInt(body.vault.seededGusd) +
          BigInt(body.vault.depositsGusd) -
          BigInt(body.vault.withdrawsGusd) +
          BigInt(body.vault.revenueGusd);
        const shares = BigInt(body.vault.sharesMinted) - BigInt(body.vault.sharesBurned);
        let rate: number;
        if (shares <= 0n) {
          rate = formatGusdRaw(await sgusd.read.convertToAssets([10n ** 6n]));
        } else {
          rate = formatGusdRaw((10n ** 6n * assets) / shares);
        }
        const [seeded, maxDeposit, maxWithdraw] = await Promise.all([
          sgusd.read.seeded(),
          sgusd.read.maxDeposit([owner]),
          sgusd.read.maxWithdraw([owner]),
        ]);
        const state: SGusdState = { rate, seeded, maxDeposit, maxWithdraw };
        return state;
      } catch {
        return rpc.sgusdState(owner);
      }
    },

    async hookFeeBps() {
      try {
        const body = await fetchJson<StatsBody>("/stats");
        if (body === null || body.stats.hookFeeBps === null) return rpc.hookFeeBps();
        return body.stats.hookFeeBps;
      } catch {
        return rpc.hookFeeBps();
      }
    },
  };
}
