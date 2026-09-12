import type { CandidateDto } from "@/data/oracle/dto";

/**
 * Static stand-in for a live candidate, used where the feed has nothing
 * (mock data source, SSR, oracle never reached). Plausible shape, clearly
 * sample values — the real thing replaces it verbatim once a candidate
 * lands. The methodology version tracks the engine's shipped default
 * (DEFAULT_METHODOLOGY_CONFIG.version in packages/pricing-engine); the live
 * value on the wire supersedes it everywhere the candidate renders.
 */
export const SAMPLE_CANDIDATE: CandidateDto = {
  gpuId: "H100_SXM_80GB",
  panelId: "H100_PANEL_V1",
  price: 2.4312,
  confidenceLow: 2.4015,
  confidenceHigh: 2.4609,
  dispersion: 0.018,
  status: "healthy",
  providersObserved: 10,
  providersContributing: 9,
  methodologyVersion: "0.4.0",
  calcHash: "sample00calculatehash0000000000000000000000000000",
  computedAt: "2026-09-04T14:00:00.000Z",
  windowStart: "2026-09-04T13:00:00.000Z",
  windowEnd: "2026-09-04T14:00:00.000Z",
};
