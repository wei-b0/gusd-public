import type { Logger } from "@gusd/types";
import type { BreakerMap, PublisherConfig, PublisherTarget } from "./types.js";
import { validateCandidate } from "./validate.js";
import type { PublisherStore } from "./store.js";

/**
 * The publisher's loop: poll the oracle's index_candidates, validate each
 * latest candidate independently, publish or record the refusal. Publishing
 * is idempotent end to end — the (candidateId, target) unique key means a
 * crash between target acknowledgement and ledger write is resolved by the
 * retry being a no-op insert.
 */
export class PublisherPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<unknown> | null = null;
  private stopped = false;

  constructor(
    private readonly opts: {
      store: PublisherStore;
      target: PublisherTarget;
      config: PublisherConfig;
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
  async tick(): Promise<{ published: number; rejected: number; skipped: number }> {
    if (this.inFlight !== null) return { published: 0, rejected: 0, skipped: 0 };
    const work = this.tickInner();
    this.inFlight = work;
    try {
      return await work;
    } finally {
      this.inFlight = null;
    }
  }

  private async tickInner(): Promise<{ published: number; rejected: number; skipped: number }> {
    const { store, target, config, logger } = this.opts;
    const now = this.opts.now?.() ?? new Date();
    const counters = { published: 0, rejected: 0, skipped: 0 };

    let breakers: BreakerMap | undefined;
    if (this.opts.fetchBreakers !== undefined) {
      try {
        breakers = await this.opts.fetchBreakers();
      } catch (err: unknown) {
        // The oracle's health endpoint is unreachable. Source health is part
        // of the gate; with it unknown we refuse — withheld is safer than
        // fabricated, and the next tick retries.
        logger.warn("source health unavailable — skipping cycle", {
          err: err instanceof Error ? err.message : String(err),
        });
        return { published: 0, rejected: 0, skipped: 0 };
      }
    }

    let candidates: Awaited<ReturnType<PublisherStore["latestCandidates"]>>;
    try {
      candidates = await store.latestCandidates();
    } catch (err: unknown) {
      logger.error("publisher could not read candidates", {
        err: err instanceof Error ? err.message : String(err),
      });
      return { published: 0, rejected: 0, skipped: 0 };
    }

    for (const candidate of candidates) {
      try {
        if (await store.alreadyPublished(candidate.id, target.name)) {
          counters.skipped += 1;
          continue;
        }

        const previousPublishedPrice = await store.latestPublishedPrice(
          candidate.gpuId,
          target.name,
        );
        const verdict = validateCandidate(candidate, {
          config,
          now,
          previousPublishedPrice,
          breakers,
        });

        if (!verdict.ok) {
          const { inserted } = await store.recordViolations(
            candidate.id,
            candidate.gpuId,
            target.name,
            verdict.violations,
            config.pinnedMethodologyVersion,
            now,
          );
          if (inserted) {
            counters.rejected += 1;
            logger.warn("candidate rejected", {
              gpuId: candidate.gpuId,
              candidateId: candidate.id,
              violations: verdict.violations,
            });
          }
          continue;
        }

        const { txRef } = await target.publish(verdict.value);
        const { inserted } = await store.recordPublication(
          verdict.value,
          txRef,
          target.name,
          config.pinnedMethodologyVersion,
          now,
        );
        if (inserted) {
          counters.published += 1;
          logger.info("candidate published", {
            gpuId: verdict.value.gpuId,
            candidateId: verdict.value.candidateId,
            txRef,
          });
        }
      } catch (err: unknown) {
        // One bad candidate must not stop the others; the ledger stays
        // consistent because publication is idempotent.
        logger.error("publisher candidate handling failed", {
          candidateId: candidate.id,
          gpuId: candidate.gpuId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return counters;
  }
}
