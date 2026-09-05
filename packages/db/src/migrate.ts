import { fileURLToPath } from "node:url";
import type { DbHandle } from "./client.js";

/**
 * Apply the package's migrations. Exposed as the "./migrate" subpath (not
 * the main barrel) so bundlers pulling @gusd/db into an app never see the
 * runtime migrations-folder reference — only tests and the CLI import this.
 */
export async function migrateDb(handle: DbHandle): Promise<void> {
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  await migrate(handle.db, {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
}
