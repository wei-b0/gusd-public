/**
 * The server's one database handle. A route process opens exactly one pool
 * (module-lazy so a cold process with no DB traffic never connects).
 */

import { createDb } from "@gusd/db";
import { getServerEnv } from "./env";

type DbHandle = ReturnType<typeof createDb>;

let handle: DbHandle | null = null;

export function getDb(): DbHandle {
  if (!handle) handle = createDb(getServerEnv().databaseUrl);
  return handle;
}
