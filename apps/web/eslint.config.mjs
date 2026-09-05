import { config } from "@gusd/eslint-config/base";

export default [
  ...config,
  {
    ignores: [".next/**", "next-env.d.ts", ".impeccable/**", "public/**"],
  },
  {
    // Node scripts (the mock-oracle fixture server) run outside the browser
    // bundle; the shared config declares no environment globals, and tsc does
    // not check .mjs — so no-undef has nothing true to say here.
    files: ["scripts/**/*.mjs"],
    rules: { "no-undef": "off" },
  },
];
