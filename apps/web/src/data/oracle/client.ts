/**
 * REST client for the oracle API. Transport only — no retry policy (the feed
 * owns that), no caching (the feed owns that), no base-URL logic (config owns
 * that). Requests stay CORS-simple: GET, no custom headers, no preflight.
 */

import { FETCH_TIMEOUT_MS, ORACLE_BASE_URL } from "./config";
import type {
  CandidateDto,
  CandlesResponse,
  HealthResponse,
  HistoryResponse,
  PanelProvidersDto,
  PricesResponse,
  ProviderDto,
  ProvidersResponse,
} from "./dto";

export class OracleFetchError extends Error {
  kind: "network" | "http";
  status?: number;

  constructor(kind: "network" | "http", message: string, status?: number) {
    super(message);
    this.name = "OracleFetchError";
    this.kind = kind;
    this.status = status;
  }
}

export interface OracleClient {
  /** Latest candidate per settlement panel. */
  listPrices(): Promise<CandidateDto[]>;
  /** Latest candidate for one gpu, or null when none was ever computed (404
   *  is a legitimate answer here, not a transport failure). */
  getPrice(gpuParam: string): Promise<CandidateDto | null>;
  /** Candidate history, OLDEST-FIRST regardless of the wire order. */
  getHistory(gpuParam: string, limit: number): Promise<CandidateDto[]>;
  /** OHLC buckets over the canonical benchmark series, oldest-first, for
   *  [fromMs, toMs] at the given grain. */
  getCandles(
    gpuParam: string,
    intervalSec: number,
    fromMs: number,
    toMs: number,
  ): Promise<CandlesResponse>;
  listProviders(): Promise<ProviderDto[]>;
  /** Contributor panel behind the latest candidate for one gpu. */
  getPanelProviders(gpuParam: string): Promise<PanelProvidersDto>;
  /** Health snapshot; a 503 body is data and is parsed, not thrown. */
  getHealth(): Promise<HealthResponse>;
}

export function createOracleClient(baseUrl: string = ORACLE_BASE_URL): OracleClient {
  async function get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (cause) {
      throw new OracleFetchError("network", `oracle ${path} failed: ${String(cause)}`);
    }
    if (!res.ok) {
      throw new OracleFetchError("http", `oracle ${path} responded ${res.status}`, res.status);
    }
    return (await res.json()) as T;
  }

  return {
    async listPrices() {
      const body = await get<PricesResponse>("/v1/prices");
      return body.prices;
    },

    async getPrice(gpuParam) {
      // 404 means "no candidate ever computed" — a legitimate answer here,
      // not a transport failure.
      const res = await fetch(`${baseUrl}/v1/prices/${encodeURIComponent(gpuParam)}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new OracleFetchError("http", `oracle price ${gpuParam} responded ${res.status}`, res.status);
      }
      return (await res.json()) as CandidateDto;
    },

    async getHistory(gpuParam, limit) {
      const body = await get<HistoryResponse>(
        `/v1/prices/${encodeURIComponent(gpuParam)}/history?limit=${limit}`,
      );
      // The wire is newest-first; every downstream consumer sees oldest-first.
      return body.history.slice().reverse();
    },

    async getCandles(gpuParam, intervalSec, fromMs, toMs) {
      // The server serves buckets oldest-first — already the consumer order.
      return get<CandlesResponse>(
        `/v1/prices/${encodeURIComponent(gpuParam)}/candles?intervalSec=${intervalSec}&from=${fromMs}&to=${toMs}`,
      );
    },

    async listProviders() {
      const body = await get<ProvidersResponse>("/v1/providers");
      return body.providers;
    },

    async getPanelProviders(gpuParam) {
      return get<PanelProvidersDto>(`/v1/prices/${encodeURIComponent(gpuParam)}/providers`);
    },

    async getHealth() {
      // A 503 still carries the health document — the oracle accurately
      // reporting a DB outage is data, not a transport error.
      const res = await fetch(`${baseUrl}/v1/health`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      return (await res.json()) as HealthResponse;
    },
  };
}