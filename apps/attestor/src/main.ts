import pino from "pino";
import { privateKeyToAccount } from "viem/accounts";
import { createDb } from "@gusd/db";
import { SETTLEMENT_PANELS } from "@gusd/gpu-catalog";
import { parseAttestorEnv } from "./env.js";
import { DrizzleAttestorStore } from "./store.js";
import { AttestorPoller } from "./poller.js";
import { fetchBreakerMap } from "./health.js";
import { reportSigner } from "./signer.js";
import type { Logger } from "@gusd/types";

/**
 * The repo's Logger contract (@gusd/types) is message-first — (msg, fields?) —
 * while pino's runtime is fields-first. Raw pino structurally satisfies the
 * interface, but it treats a message-first fields object as interpolation data
 * and drops it, so every module log arrives bare. Adapt at this boundary: the
 * composition root owns pino; modules only ever see the contract.
 */
function asLogger(pinoLogger: pino.Logger): Logger {
  const fields = (obj: unknown): object => {
    if (obj === undefined) return {};
    if (obj instanceof Error) return { err: obj }; // pino's default err serializer
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

async function main(): Promise<void> {
  const env = parseAttestorEnv();
  const logger = asLogger(pino({ level: env.logLevel }));

  const account = privateKeyToAccount(env.privateKey);
  const handle = createDb(env.databaseUrl);
  const store = new DrizzleAttestorStore(
    handle.db,
    SETTLEMENT_PANELS.map((p) => p.gpuId),
  );
  const poller = new AttestorPoller({
    store,
    signer: reportSigner(account),
    domain: { chainId: env.chainId, verifyingContract: env.oracleAddress },
    config: env,
    epochLength: env.epochLength,
    maxObservationAge: env.maxObservationAge,
    logger,
    fetchBreakers: () => fetchBreakerMap(env.oracleUrl, fetch),
  });

  const shutdown = (signal: string): void => {
    logger.info("attestor shutting down", { signal });
    void (async () => {
      await poller.stop();
      await handle.close();
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  poller.start(env.pollMs);
  logger.info("attestor polling", {
    pollMs: env.pollMs,
    oracleUrl: env.oracleUrl,
    attestor: account.address,
    chainId: env.chainId,
    verifyingContract: env.oracleAddress,
    epochLength: env.epochLength,
    maxObservationAge: env.maxObservationAge,
  });
}

main().catch((err: unknown) => {
  // Startup failures are fatal and loud — an attestor that half-starts could
  // be trusted to sign when it is not running at all.
  process.exitCode = 1;
  console.error(err);
});
