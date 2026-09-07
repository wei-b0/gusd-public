import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Ponder's virtual schema module — the real schema file imports only
      // the `ponder` package, so tests of handler-level helpers (bucket
      // upserts) can load it directly under vitest.
      "ponder:schema": fileURLToPath(
        new URL("./ponder.schema.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
  },
});
