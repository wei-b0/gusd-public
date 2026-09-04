import pino from "pino";
import { createDb } from "@gusd/db";
import { SETTLEMENT_PANELS } from "@gusd/gpu-catalog";
import { parsePublisherEnv } from "./env.js";
import { DrizzlePublisherStore } from "./store.js";
import { MockPublisherTarget } from "./target.js";
import { ChainPublisherTarget } from "./chain-target.js";
import { createViemChainClient } from "./viem-chain-client.js";
import { PublisherPoller } from "./poller.js";
import { fetchBreakerMap } from "./health.js";
import type { PublisherTarget } from "./types.js";

async function main(): Promise<void> {
  const env = parsePublisherEnv();
  const logger = pino({ level: env.logLevel });

  const handle = createDb(env.databaseUrl);
  const store = new DrizzlePublisherStore(
    handle.db,
    SETTLEMENT_PANELS.map((p) => p.gpuId),
  );
  let target: PublisherTarget;
  if (env.target === "chain") {
    // verify() aborts boot loudly on chain-id / PRICE_SCALE / publisher
    // mismatch — a wrong publisher identity would make every publish revert.
    const client = createViemChainClient({
      rpcUrl: env.rpcUrl!,
      privateKey: env.privateKey!,
      oracleAddress: env.oracleAddress!,
      chainId: env.chainId!,
      txTimeoutMs: env.txTimeoutMs,
    });
    const chainTarget = new ChainPublisherTarget(client, {
      accountAddress: client.accountAddress,
      expectedChainId: env.chainId!,
    });
    await chainTarget.verify();
    target = chainTarget;
  } else {
    target = new MockPublisherTarget();
  }
  const poller = new PublisherPoller({
    store,
    target,
    config: env,
    logger,
    fetchBreakers: () => fetchBreakerMap(env.oracleUrl, fetch),
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "publisher shutting down");
    void (async () => {
      await poller.stop();
      await handle.close();
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  poller.start(env.pollMs);
  logger.info(
    { pollMs: env.pollMs, oracleUrl: env.oracleUrl, target: target.name },
    "publisher polling",
  );
}

main().catch((err: unknown) => {
  // Startup failures are fatal and loud — a publisher that half-starts could
  // be trusted to publish when it is not running at all.
  process.exitCode = 1;
  console.error(err);
});
