import type { Logger } from "@gusd/types";
import type { MethodologyConfig } from "@gusd/pricing-engine";
import type { GpuOracleDomain, ReportV1, SignerLike } from "@gusd/attestor-client";
import {
  buildReport,
  encodeUpdateData,
  epochOf,
  observationSeconds,
  reportHash,
  signReport,
} from "@gusd/attestor-client";

import type { GpuOracleDomain, SignerLike } from "@gusd/attestor-client";
import type { AttestorConfig, BreakerMap } from "./types.js";
import { assessCandidate } from "./validate.js";
import { resolvePanelThresholds } from "./thresholds.js";
import type { AttestorStore } from "./store.js";

/**
 * The attestor's loop: poll the oracle's index_candidates, audit each latest
 * candidate independently, and attest the accepted one into the CURRENT epoch
 * — build a Report (observedAt = candidate.computedAt clamped ≤ now; epoch =
 * the epoch being attested INTO), EIP-712-sign it, and persist it to the
 * `reports` table the API serves from. No EVM transaction exists anywhere in
 * this process: the signature is consumed by whoever trades next.
 *
 * The per-epoch gate replaces the push era's deviation/heartbeat trigger: the
 * contract accepts exactly one report per (gpu, epoch), so every epoch needs
 * one attestation and anything after it in the same epoch is a no-op — one
 * report per epoch per GPU, re-attesting the latest healthy candidate while
 * it stays inside the observation floor. Audit verdicts never block: trades
 * need a current report, and an imperfect attested figure beats a stale or
 * absent one. They are recorded to publish_violations so the audit ledger
 * stays 1:1 with what shipped. Persistence is idempotent end to end — the
 * (gpu_id, epoch) unique key means a crash after signing resolves by the
 * retry being a no-op insert.
 */
export class AttestorPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<unknown> | null = null;

  constructor(
    private readonly opts: {
      store: AttestorStore;
      signer: SignerLike;
      /** The EIP-712 domain: chainId + GpuOracle address (verifyingContract). */
      domain: GpuOracleDomain;
      config: AttestorConfig;
      epochLength: number;
      maxObservationAge: number;
      logger: Logger;
      /** When absent, contributor source health is not re-checked. */
      fetchBreakers?: () => Promise<BreakerMap>;
      now?: () => Date;
    },
  ) {}

  start(pollMs: number): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        /* tick never throws — see catch inside */
      });
    }, pollMs);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  /** One evaluation pass over every watched gpu. */
  async tick(): Promise<{ attested: number; flagged: number; skipped: number }> {
    if (this.inFlight !== null) return { attested: 0, flagged: 0, skipped: 0 };
    const work = this.tickInner();
    this.inFlight = work;
    try {
      return await work;
    } finally {
      this.inFlight = null;
    }
  }

  private async tickInner(): Promise<{ attested: number; flagged: number; skipped: number }> {
    const { store, config, logger } = this.opts;
    const now = this.opts.now?.() ?? new Date();
    const counters = { attested: 0, flagged: 0, skipped: 0 };

    let breakers: BreakerMap | undefined;
    if (this.opts.fetchBreakers !== undefined) {
      try {
        breakers = await this.opts.fetchBreakers();
      } catch (err: unknown) {
        // The oracle's health endpoint is unreachable. Source health is part
        // of the audit; with it unknown we refuse — skipped is safer than
        // unannotated, and the next tick retries.
        logger.warn("source health unavailable — skipping cycle", {
          err: err instanceof Error ? err.message : String(err),
        });
        return { attested: 0, flagged: 0, skipped: 0 };
      }
    }

    let candidates: Awaited<ReturnType<AttestorStore["latestCandidates"]>>;
    try {
      candidates = await store.latestCandidates();
    } catch (err: unknown) {
      logger.error("attestor could not read candidates", {
        err: err instanceof Error ? err.message : String(err),
      });
      return { attested: 0, flagged: 0, skipped: 0 };
    }

    // The audit thresholds come from the stored methodology row for the
    // pinned version — per-panel quorums and dispersion caps included. A
    // missing row is fail-closed: without a methodology there is nothing to
    // audit against, and guessing one would defeat the pin.
    let methodology: MethodologyConfig | null;
    try {
      methodology = await store.methodologyConfig(config.pinnedMethodologyVersion);
    } catch (err: unknown) {
      logger.error("attestor could not read the methodology row", {
        err: err instanceof Error ? err.message : String(err),
      });
      return { attested: 0, flagged: 0, skipped: 0 };
    }
    if (methodology === null) {
      logger.warn("pinned methodology version missing from the database — refusing to attest", {
        pinnedMethodologyVersion: config.pinnedMethodologyVersion,
      });
      return { attested: 0, flagged: 0, skipped: 0 };
    }

    const nowSec = Math.floor(now.getTime() / 1000);
    for (const candidate of candidates) {
      try {
        const epoch = epochOf(nowSec, this.opts.epochLength);
        // One report per (gpu, epoch): the first tick after a boundary does
        // the work, every later tick in the epoch is a no-op — the contract
        // would bind only the first anyway.
        if (await store.reportForEpoch(candidate.gpuId, epoch)) {
          counters.skipped += 1;
          continue;
        }

        const previous = await store.latestReport(candidate.gpuId);
        const assessment = assessCandidate(candidate, {
          config: resolvePanelThresholds(config, methodology, candidate.panelId),
          now,
          previousPublishedPrice: previous?.price ?? null,
          breakers,
        });

        if (assessment.value === null) {
          // A genuine refusal: nothing exists to attest. Recorded once per
          // (candidateId, target) so the audit sees why this candidate died.
          const { inserted } = await store.recordViolations(
            candidate.id,
            candidate.gpuId,
            TARGET,
            assessment.violations,
            config.pinnedMethodologyVersion,
            now,
          );
          counters.skipped += 1;
          logger.warn("candidate not attestable — no price", {
            gpuId: candidate.gpuId,
            candidateId: candidate.id,
            violations: assessment.violations,
            recorded: inserted,
          });
          continue;
        }

        // Observation floor — the one hard stop besides a missing price. The
        // contract rejects reports with observedAt < now − MAX_OBSERVATION_AGE,
        // so signing a report that would fail consumption wastes nothing and
        // proves nothing; the next fresh candidate attests instead.
        const value = assessment.value;
        const observedAtSec = observationSeconds(Date.parse(value.computedAt), now.getTime());
        const ageSec = nowSec - observedAtSec;
        if (ageSec > this.opts.maxObservationAge) {
          const { inserted } = await store.recordViolations(
            candidate.id,
            candidate.gpuId,
            TARGET,
            [
              ...assessment.violations,
              {
                code: "observation_beyond_floor",
                detail: `observation is ${ageSec}s old (floor ${this.opts.maxObservationAge}s) — nothing to attest`,
              },
            ],
            config.pinnedMethodologyVersion,
            now,
          );
          counters.skipped += 1;
          logger.warn("candidate observation beyond the floor — not attestable", {
            gpuId: candidate.gpuId,
            candidateId: candidate.id,
            ageSec,
            floor: this.opts.maxObservationAge,
            recorded: inserted,
          });
          continue;
        }

        const report = buildReport({
          gpuId: value.gpuId,
          price: value.price,
          observedAtSec,
          nowSec,
          epochLength: this.opts.epochLength,
          maxObservationAge: this.opts.maxObservationAge,
          calcHash: calcHashBytes32(value.calcHash),
        });
        const signed = await signReport(this.opts.signer, report, this.opts.domain);

        // Audit annotations ride attestations: one publish_violations row per
        // attested report (joined by candidate_id), never one per polled
        // candidate — suppressed epochs would otherwise flood the ledger.
        if (assessment.violations.length > 0) {
          const { inserted } = await store.recordViolations(
            candidate.id,
            candidate.gpuId,
            TARGET,
            assessment.violations,
            config.pinnedMethodologyVersion,
            now,
          );
          if (inserted) {
            counters.flagged += 1;
            logger.warn("candidate flagged — attesting regardless (epoch policy)", {
              gpuId: candidate.gpuId,
              candidateId: candidate.id,
              violations: assessment.violations,
            });
          }
        }

        const { inserted } = await store.recordReport({
          version: report.version,
          gpuId: value.gpuId,
          candidateId: value.candidateId,
          price: Number(report.price),
          observedAt: report.observedAt,
          epoch: report.epoch,
          validFrom: report.validFrom,
          validUntil: report.validUntil,
          calcHash: report.calcHash,
          signature: signed.signature,
          reportHash: reportHash(signed),
          attestedAt: now,
        });
        if (inserted) {
          counters.attested += 1;
          logger.info("report attested", {
            gpuId: value.gpuId,
            candidateId: value.candidateId,
            price: value.price,
            epoch: report.epoch,
            updateData: encodeUpdateData(signed),
          });
        }
      } catch (err: unknown) {
        // One bad candidate must not stop the others; the ledger stays
        // consistent because attestation is idempotent.
        logger.error("attestor candidate handling failed", {
          candidateId: candidate.id,
          gpuId: candidate.gpuId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return counters;
  }
}

/** The violations ledger's target column — one attestor target, no chain. */
const TARGET = "attestor";

/**
 * The engine stamps candidates with bare sha256 hex; the Report carries
 * bytes32. Fail closed on anything else — a malformed calcHash means the
 * report could not be tied to a reproducible engine run.
 */
export function calcHashBytes32(calcHash: string): `0x${string}` {
  if (/^0x[0-9a-fA-F]{64}$/.test(calcHash)) return calcHash as `0x${string}`;
  if (/^[0-9a-fA-F]{64}$/.test(calcHash)) return `0x${calcHash}` as `0x${string}`;
  throw new Error(`calcHash is not a 32-byte hex digest: "${calcHash}"`);
}
