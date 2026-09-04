import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { createDb, DEFAULT_DATABASE_URL } from "./client.js";

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd !== "migrate") {
    console.error(`usage: tsx src/cli.ts migrate`);
    process.exit(1);
  }
  const handle = createDb(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  try {
    await migrate(handle.db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    console.log("migrations applied");
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
