/**
 * The user_events write helper — the DB leg of the projection (the pure row
 * build lives in src/projections/user-event.ts). Called by exactly the seven
 * user-facing event handlers; every write is one user_events insert plus the
 * wallets registry stamp, inside Envio's event transaction.
 */
import { userEvents, wallets } from "../schema.js";
import {
  projectUserEvent,
  type UserEventInput,
} from "../projections/user-event.js";

/**
 * Minimal structural view of the entity context — what this helper needs,
 * no more, so call sites pass their context.db straight through. Same
 * doctrine as WalletStateDb: find's return stays an open record because
 * checking it against a specific select model instantiates it to one;
 * strong typing lives in the pure projection (projections/user-event.ts).
 * Both inserts ride one overload (the tables share the Table signature):
 * user_events stays insert-once by usage, wallets upserts on conflict.
 */
interface UserEventDb {
  find(
    table: typeof wallets,
    key: { chainId: number; address: string },
  ): Promise<{ [column: string]: any } | null>;
  insert(table: typeof userEvents | typeof wallets): {
    values(
      value: typeof userEvents.$inferInsert | typeof wallets.$inferInsert,
    ): {
      onConflictDoUpdate(
        set: Partial<typeof wallets.$inferInsert>,
      ): Promise<unknown>;
    };
  };
}

/**
 * Write one user-attributed evidence row and stamp the wallet registry.
 * The wallets stamps are read-then-write (same convergence pattern as the
 * pools counters): handlers run sequentially per chain and reorg replay
 * re-runs them over rolled-back state, so first/last-seen min/max and the
 * eventCount delta converge without absolute recomputes.
 */
export async function recordUserEvent(
  db: UserEventDb,
  input: UserEventInput,
): Promise<void> {
  const row = projectUserEvent(input);
  await db.insert(userEvents).values(row);

  const wallet = await db.find(wallets, {
    chainId: row.chainId,
    address: row.user,
  });
  const firstSeenBlockNumber =
    wallet === null || wallet === undefined
      ? row.blockNumber
      : Math.min(wallet.firstSeenBlockNumber, row.blockNumber);
  const lastSeenBlockNumber =
    wallet === null || wallet === undefined
      ? row.blockNumber
      : Math.max(wallet.lastSeenBlockNumber, row.blockNumber);
  const eventCount =
    wallet === null || wallet === undefined ? 1 : wallet.eventCount + 1;

  await db
    .insert(wallets)
    .values({
      chainId: row.chainId,
      address: row.user,
      firstSeenBlockNumber,
      lastSeenBlockNumber,
      eventCount,
    })
    .onConflictDoUpdate({
      firstSeenBlockNumber,
      lastSeenBlockNumber,
      eventCount,
    });
}
