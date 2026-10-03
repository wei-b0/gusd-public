/**
 * Keeper health: the hot key's native balance and the book's shape, logged
 * on a slow interval. No HTTP surface — the compose posture treats a dead
 * keeper like the attestor (restart: unless-stopped + observable logs);
 * the balance alarm is the actionable signal (a keeper out of gas is a
 * silent do-nothing service otherwise).
 */
import type { Logger } from "@gusd/types";
import type { Executor } from "./execute.js";
import type { Book } from "./state.js";

export function startHealthLoop(opts: {
  executor: Executor;
  book: Book;
  minBalanceWei: bigint;
  intervalMs: number;
  logger: Logger;
}): () => void {
  const { executor, book, minBalanceWei, intervalMs, logger } = opts;
  const tick = async (): Promise<void> => {
    try {
      const balance = await executor.executorBalanceWei();
      if (balance < minBalanceWei / 2n) {
        logger.error("keeper hot key critically low on gas — executions will stop", {
          balanceEth: Number(balance) / 1e18,
          floorEth: Number(minBalanceWei / 2n) / 1e18,
        });
      } else if (balance < minBalanceWei) {
        logger.warn("keeper hot key low on gas", {
          balanceEth: Number(balance) / 1e18,
          floorEth: Number(minBalanceWei) / 1e18,
        });
      }
      logger.info("keeper heartbeat", {
        balanceEth: Number(balance) / 1e18,
        markets: book.markets.size,
        openPositions: book.positions.size,
        pendingOrders: book.orders.size,
        bookGeneration: book.generation,
      });
    } catch (err) {
      logger.warn("health check failed", { err: String(err) });
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(timer);
}