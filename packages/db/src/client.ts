import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.js";

export type Db = NodePgDatabase<typeof schema>;

/**
 * A connection pool + drizzle client. Every entry point takes an explicit
 * `Executor` (the db or a transaction) so the ingestion service can make
 * run+raw+normalized writes atomic without this package knowing about
 * ingestion.
 */
export type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface DbHandle {
  db: Db;
  pool: Pool;
  close(): Promise<void>;
}

export const DEFAULT_DATABASE_URL = "postgres://gusd:gusd@localhost:54329/gusd";

export function createDb(databaseUrl: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL): DbHandle {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

export { schema };
