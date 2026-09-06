import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // The gated suites (RUN_ANVIL_TESTS=1) all drive one shared anvil node —
    // their wallet-funded sequences race if the files run in parallel. Unit
    // suites stay parallel.
    fileParallelism: process.env.RUN_ANVIL_TESTS !== "1",
  },
});
