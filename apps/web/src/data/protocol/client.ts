/**
 * REST client for the oracle's /v1/protocol/* routes (Envio-indexed data).
 * Transport only, mirroring ../oracle/client.ts: no retry, no caching, no
 * base-URL logic beyond the lazy env read, CORS-simple GETs, 5s timeout.
 *
 * NEXT_PUBLIC_INDEXER_URL carries the /v1/protocol prefix (it names the
 * whole route family, not the host root). Absent ⇒ protocolBaseUrl() is
 * null and every consumer stays inert — zero network calls, never an error.
 */

import { FETCH_TIMEOUT_MS } from "@/data/oracle/config";
import type { IndexedEvent } from "@/domain/indexer";
import type {
  ExecutionsBody,
  GpuAssetDto,
  GpusBody,
  OracleStateBody,
  PoolStatsBody,
  PoolsBody,
  StatsBody,
  SwapsBody,
  WalletBalancesBody,
  WalletPositionsBody,
} from "./dto";

/** The user-events envelope — the only one whose member type is pinned in
 *  the domain contract (src/domain/indexer.ts), imported by name. */
export interface UserEventsBody {
  events: IndexedEvent[];
  nextCursor?: string;
}

export class ProtocolFetchError extends Error {
  kind: "network" | "http";
  status?: number;

  constructor(kind: "network" | "http", message: string, status?: number) {
    super(message);
    this.name = "ProtocolFetchError";
    this.kind = kind;
    this.status = status;
  }
}

/** The configured base URL with any trailing slashes stripped, or null when
 *  the indexer is not configured (the inert mode). */
export function protocolBaseUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_INDEXER_URL;
  if (raw === undefined) return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed === "" ? null : trimmed;
}

export interface ProtocolClient {
  /** One page of the wallet's indexed events, newest first. */
  getUserEvents(
    address: string,
    query?: { fromBlock?: number; events?: readonly string[]; limit?: number; cursor?: string },
  ): Promise<UserEventsBody>;
  /** Protocol-token balances from raw Transfers. */
  getWalletBalances(address: string): Promise<WalletBalancesBody>;
  /** Cost-basis positions (avgEntry/realizedPnl gated on basisState). */
  getWalletPositions(address: string): Promise<WalletPositionsBody>;
  /** Routed executions with legs, newest first. */
  getWalletExecutions(
    address: string,
    query?: { limit?: number; cursor?: string },
  ): Promise<ExecutionsBody>;
  /** Every registered pool with its derived state. */
  listPools(): Promise<PoolsBody>;
  /** Hourly volume buckets for one pool (intervalSec fixed at 3600 — the
   *  only stored grain). */
  getPoolStats(
    poolId: string,
    query?: { fromSec?: number; toSec?: number },
  ): Promise<PoolStatsBody>;
  /** The AMM primitive tape for one pool, newest first. */
  getPoolSwaps(
    poolId: string,
    query?: { limit?: number; cursor?: string },
  ): Promise<SwapsBody>;
  /** Per-asset protocol stats (catalog joined at the API boundary). */
  listGpus(): Promise<GpusBody>;
  /** One GPU asset, or null on 404 (never seen — a legitimate answer). */
  getGpu(gpuParam: string): Promise<GpuAssetDto | null>;
  /** Protocol aggregates + the sgUSD vault. Either may be null pre-data. */
  getStats(): Promise<StatsBody>;
  /** Indexed oracle publication state for one gpu — transparency only.
   *  Null oracle means "no publication yet", distinct from 404-on-garbage. */
  getOracleState(
    gpuParam: string,
    query?: { history?: boolean; limit?: number },
  ): Promise<OracleStateBody>;
}

export function createProtocolClient(baseUrl: string): ProtocolClient {
  const base = baseUrl.replace(/\/+$/, "");

  async function get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (cause) {
      throw new ProtocolFetchError("network", `protocol ${path} failed: ${String(cause)}`);
    }
    if (!res.ok) {
      throw new ProtocolFetchError("http", `protocol ${path} responded ${res.status}`, res.status);
    }
    return (await res.json()) as T;
  }

  async function getOrNullOn404<T>(path: string): Promise<T | null> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (cause) {
      throw new ProtocolFetchError("network", `protocol ${path} failed: ${String(cause)}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new ProtocolFetchError("http", `protocol ${path} responded ${res.status}`, res.status);
    }
    return (await res.json()) as T;
  }

  function pageQuery(limit?: number, cursor?: string): string {
    const parts: string[] = [];
    if (limit !== undefined) parts.push(`limit=${limit}`);
    if (cursor !== undefined && cursor !== "") parts.push(`cursor=${encodeURIComponent(cursor)}`);
    return parts.length === 0 ? "" : `?${parts.join("&")}`;
  }

  return {
    async getUserEvents(address, query) {
      const parts: string[] = [`address=${encodeURIComponent(address.toLowerCase())}`];
      if (query?.fromBlock !== undefined) parts.push(`fromBlock=${query.fromBlock}`);
      if (query?.events !== undefined && query.events.length > 0) {
        parts.push(`events=${query.events.map(encodeURIComponent).join(",")}`);
      }
      if (query?.limit !== undefined) parts.push(`limit=${query.limit}`);
      if (query?.cursor) parts.push(`cursor=${encodeURIComponent(query.cursor)}`);
      return get<UserEventsBody>(`/user-events?${parts.join("&")}`);
    },

    async getWalletBalances(address) {
      return get<WalletBalancesBody>(`/wallets/${address.toLowerCase()}/balances`);
    },

    async getWalletPositions(address) {
      return get<WalletPositionsBody>(`/wallets/${address.toLowerCase()}/positions`);
    },

    async getWalletExecutions(address, query) {
      return get<ExecutionsBody>(
        `/wallets/${address.toLowerCase()}/executions${pageQuery(query?.limit, query?.cursor)}`,
      );
    },

    async listPools() {
      return get<PoolsBody>("/pools");
    },

    async getPoolStats(poolId, query) {
      const parts: string[] = ["intervalSec=3600"];
      if (query?.fromSec !== undefined) parts.push(`from=${query.fromSec}`);
      if (query?.toSec !== undefined) parts.push(`to=${query.toSec}`);
      return get<PoolStatsBody>(`/pools/${poolId.toLowerCase()}/stats?${parts.join("&")}`);
    },

    async getPoolSwaps(poolId, query) {
      return get<SwapsBody>(`/pools/${poolId.toLowerCase()}/swaps${pageQuery(query?.limit, query?.cursor)}`);
    },

    async listGpus() {
      return get<GpusBody>("/gpus");
    },

    async getGpu(gpuParam) {
      return getOrNullOn404<import("./dto").GpuAssetDto>(`/gpus/${encodeURIComponent(gpuParam)}`);
    },

    async getStats() {
      return get<StatsBody>("/stats");
    },

    async getOracleState(gpuParam, query) {
      const parts: string[] = [];
      if (query?.history === true) parts.push("history=1");
      if (query?.limit !== undefined) parts.push(`limit=${query.limit}`);
      const qs = parts.length === 0 ? "" : `?${parts.join("&")}`;
      return get<OracleStateBody>(`/oracle/${encodeURIComponent(gpuParam)}${qs}`);
    },
  };
}

// --- singleton seam -----------------------------------------------------------

let singleton: ProtocolClient | null = null;

/** The shared client. Null when NEXT_PUBLIC_INDEXER_URL is unset — callers
 *  treat null as "indexer not configured", never an error. */
export function getProtocolClient(): ProtocolClient | null {
  if (singleton !== null) return singleton;
  const base = protocolBaseUrl();
  if (base === null) return null;
  singleton = createProtocolClient(base);
  return singleton;
}

/** Test seam: drops the singleton so a new env produces a fresh client. */
export function disposeProtocolClient(): void {
  singleton = null;
}
