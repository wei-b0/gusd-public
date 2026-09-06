/**
 * Mirrored wire types for the oracle API.
 *
 * Drift sources — if the oracle changes these shapes, update here:
 *   - apps/oracle/src/event-bus.ts  (CandidateDto, PanelProvidersDto)
 *   - apps/oracle/src/health.ts     (CollectorHealth, health snapshot)
 *   - apps/oracle/src/server.ts     (route envelopes, provider registry rows)
 *
 * The web deliberately does not depend on @gusd workspace packages; this
 * surface is small, versioned by the candidates' methodologyVersion, and
 * covered by the fixture server that speaks the same shapes.
 */

/** One published index computation, as broadcast and served. */
export interface CandidateDto {
  gpuId: string;
  panelId: string;
  price: number | null;
  confidenceLow: number | null;
  confidenceHigh: number | null;
  dispersion: number;
  status: string;
  providersObserved: number;
  providersContributing: number;
  methodologyVersion: string;
  calcHash: string;
  computedAt: string;
  windowStart: string;
  windowEnd: string;
}

/** Registry row from GET /v1/providers — metadata only, no prices. */
export interface ProviderDto {
  slug: string;
  name: string;
  sourceType: string;
  role: string;
  cadenceTier: string;
  homepageUrl: string | null;
  config: Record<string, unknown>;
}

/** One contributor behind a candidate (GET /v1/prices/:gpu/providers). */
export interface PanelProviderDto {
  providerId: string;
  slug: string;
  name: string;
  role: string;
  price: number;
  executable: boolean;
  sampleSize: number;
  method: string;
  weightPct: number;
  sigma: number | null;
  lastObservedAt: string | null;
}

export interface PanelExclusionDto {
  providerId: string;
  reason: string;
  detail?: string;
}

/** GET /v1/prices/:gpu/providers — the panel behind the latest candidate. */
export interface PanelProvidersDto {
  gpuId: string;
  panelId: string;
  status: string;
  computedAt: string;
  windowStart: string;
  windowEnd: string;
  providers: PanelProviderDto[];
  exclusions: PanelExclusionDto[];
}

/** Per-collector health from GET /v1/health. */
export interface CollectorHealthDto {
  collectorId: string;
  providerSlug: string;
  breakerOpen: boolean;
  breakerOpenedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureKind: string | null;
  consecutiveFailures: number;
}

/** GET /v1/health — a 503 body is data (the oracle reporting a DB outage),
 *  not a transport error; callers must parse it either way. */
export interface HealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  db: boolean;
  collectors: CollectorHealthDto[];
}

export interface PricesResponse {
  prices: CandidateDto[];
}

export interface HistoryResponse {
  history: CandidateDto[];
}

export interface ProvidersResponse {
  providers: ProviderDto[];
}

/** One OHLC bucket over the canonical benchmark series
 *  (GET /v1/prices/:gpu/candles). `t` is the interval open, epoch ms;
 *  open/high/low/close aggregate the computed benchmarks that landed in the
 *  interval; samples is how many rows fed the bucket. `carried` marks a
 *  server-synthesized bucket: the interval was silent, so the grid carries
 *  the previous close flat (o=h=l=c=prev.close, samples 0) to keep `t`
 *  spacing regular — it asserts "nothing new landed", never a level. */
export interface CandleDto {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  samples: number;
  carried?: boolean;
}

export interface CandlesResponse {
  gpuId: string;
  panelId: string;
  intervalSec: number;
  from: string;
  to: string;
  candles: CandleDto[];
}
