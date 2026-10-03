/**
 * The keeper's composition root. Boot order:
 *
 *   1. env + deployment record (loud exit when either is wrong)
 *   2. engine RPC: minOrderDelay (boot-retried — anvil may lag the keeper)
 *   3. one full book load from the indexer's Postgres entities
 *   4. the oracle candidate stream (WS, SSE fallback)
 *
 * Tick flow: dedupe on (calcHash, book generation) → evaluateTick → work
 * items → ONE attestation fetch per gpu → serialized sim-gated broadcasts →
 * receipt reconciliation. The chain clock is synced on boot and each
 * periodic reload; between syncs the keeper extrapolates wall-clock elapsed
 * time (only the minOrderDelay check and the funding advance read it —
 * both tolerate small drift, and the sim aborts on being early).
 */
import pino from "pino";
import type { Logger } from "@gusd/types";
import { parseKeeperEnv, readDeploymentRecord, type DeploymentRecord } from "./env.js";
import { Book, openPool } from "./state.js";
import { Executor } from "./execute.js";
import { connectCandidates, type StreamHandle } from "./stream.js";
import { evaluateTick, type CandidateTick } from "./strategy.js";
import { startHealthLoop } from "./health.js";

/** The repo's Logger contract (@gusd/types) is message-first; pino is
 *  fields-first. Adapt here — modules only see the contract. */
function asLogger(pinoLogger: pino.Logger): Logger {
  const fields = (obj: unknown): object => {
    if (obj === undefined) return {};
    if (obj instanceof Error) return { err: obj };
    if (typeof obj === "object" && obj !== null) return obj;
    return { value: obj };
  };
  return {
    debug: (msg, obj) => pinoLogger.debug(fields(obj), msg),
    info: (msg, obj) => pinoLogger.info(fields(obj), msg),
    warn: (msg, obj) => pinoLogger.warn(fields(obj), msg),
    error: (msg, obj) => pinoLogger.error(fields(obj), msg),
  };
}

/** Waits until `attempt()` resolves (rpc readiness at boot). */
async function bootRetry<T>(what: string, attempt: () => Promise<T>, logger: Logger, tries = 30): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (i >= tries) throw err;
      logger.warn("boot step failed — retrying", { what, attempt: i, err: String(err) });
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

interface Keeper {
  stop(): Promise<void>;
}

async function startKeeper(
  env: ReturnType<typeof parseKeeperEnv>,
  record: DeploymentRecord,
  logger: Logger,
): Promise<Keeper> {
  const executor = new Executor(new Book(await openPool(env.databaseUrl), env.indexerSchema, env.chainId), record.perpEngine, env, logger);
  const book = executor.book;

  const minOrderDelaySec = await bootRetry("minOrderDelay read", () => executor.minOrderDelay(), logger);
  await bootRetry("initial book load", () => book.load(), logger);
  logger.info("book loaded", {
    markets: book.markets.size,
    openPositions: book.positions.size,
    pendingOrders: book.orders.size,
    engine: record.perpEngine,
    minOrderDelaySec: String(minOrderDelaySec),
  });

  // Chain clock sync: block timestamp at boot + each reload, extrapolated
  // between syncs from the wall clock.
  let chainNow = 0n;
  let chainNowSyncedMs = 0;
  const syncClock = async (): Promise<void> => {
    const block = await executor.publicClient.getBlock();
    chainNow = BigInt(block.timestamp as bigint | string);
    chainNowSyncedMs = Date.now();
  };
  await bootRetry("chain clock sync", syncClock, logger);
  const nowSec = (): bigint => {
    if (chainNow === 0n) return BigInt(Math.floor(Date.now() / 1000));
    return chainNow + BigInt(Math.max(0, Math.floor((Date.now() - chainNowSyncedMs) / 1000)));
  };

  // The last candidate per gpu — re-evaluated after each reload, since debt
  // grows with time (a position can go liquidatable without a price move).
  const lastTicks = new Map<string, CandidateTick>();
  const dedupe = new Map<string, string>();

  const processTick = (tick: CandidateTick): void => {
    const key = `${tick.gpuId}`;
    const dedupeKey = `${tick.calcHash}:${book.generation}`;
    if (dedupe.get(key) === dedupeKey) return; // nothing new: same candidate, same book
    dedupe.set(key, dedupeKey);
    lastTicks.set(key, tick);
    const items = evaluateTick(book, minOrderDelaySec, tick, nowSec());
    if (items.length === 0) return;
    logger.info("candidate produced work", {
      gpuId: tick.gpuId,
      price: tick.price,
      items: items.map((i) =>
        i.type === "executeOrder" ? `order:${String(i.orderId)}` : `liq:${i.wallet.slice(0, 8)}:${i.isLong ? "L" : "S"}`,
      ),
    });
    void executor.run(items, tick.gpuId).catch((err: unknown) => {
      logger.error("execution batch failed", { gpuId: tick.gpuId, err: String(err) });
    });
  };

  const reevaluateAll = (): void => {
    for (const [gpu, tick] of lastTicks) {
      const items = evaluateTick(book, minOrderDelaySec, tick, nowSec());
      if (items.length === 0) continue;
      logger.info("reload produced work for a stored candidate", { gpuId: gpu, items: items.length });
      void executor.run(items, tick.gpuId).catch((err: unknown) => {
        logger.error("reload execution batch failed", { gpuId: gpu, err: String(err) });
      });
    }
  };

  const stream: StreamHandle = connectCandidates(env, logger, processTick);

  // Periodic full reload — the safety net under event-driven reconciliation,
  // plus a clock resync and a debt-driven re-evaluation of stored candidates.
  const reloadTimer = setInterval(() => {
    void (async () => {
      try {
        await book.load();
        await syncClock();
        reevaluateAll();
      } catch (err) {
        logger.warn("periodic reload failed", { err: String(err) });
      }
    })();
  }, env.reloadSec * 1_000);

  const healthStop = startHealthLoop({
    executor,
    book,
    minBalanceWei: BigInt(Math.round(env.minBalanceEth * 1e18)),
    intervalMs: 60_000,
    logger,
  });

  return {
    async stop(): Promise<void> {
      stream.stop();
      clearInterval(reloadTimer);
      healthStop();
    },
  };
}

async function main(): Promise<void> {
  const env = parseKeeperEnv();
  const logger = asLogger(pino({ level: env.logLevel }));
  const record = readDeploymentRecord(env.deploymentsDir, env.chainId);
  const keeper = await startKeeper(env, record, logger);

  const shutdown = (signal: string): void => {
    logger.info("keeper shutting down", { signal });
    void (async () => {
      await keeper.stop();
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  // Startup failures are fatal and loud — a keeper that half-starts could be
  // trusted to liquidate when it is not running at all.
  process.exitCode = 1;
  console.error(err);
});