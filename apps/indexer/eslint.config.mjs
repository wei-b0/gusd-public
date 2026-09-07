import { config } from "@gusd/eslint-config/base";

export default [
  ...config,
  {
    ignores: [".ponder/**", "generated/**", "ponder-env.d.ts"],
  },
  {
    // Core `no-undef` cannot see TypeScript: the house babel parser strips
    // types without scope analysis, so interface members and type aliases
    // report as "not defined" (false positives). Core `no-unused-vars` has
    // the mirror-image blindness: imports used only in type positions report
    // as unused. The TypeScript compiler is the authority for both
    // (`pnpm check-types` runs with noUnusedLocals/noUnusedParameters and is
    // type-aware); this matches typescript-eslint's standing recommendation
    // for TS codebases. Runtime bugs are still caught by tsc and the tests.
    files: ["**/*.ts"],
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
    },
  },
  {
    // Determinism invariant: indexed state must be a pure function of chain
    // events. No wall-clock, randomness, environment, or process state may
    // enter the projections — reorg rollback + replay and the byte-identical
    // re-backfill test both depend on it. Wall-clock wire fields (seenAtMs)
    // are mapped at the API boundary, never here.
    files: [
      "src/handlers/**/*.ts",
      "src/projections/**/*.ts",
      "src/events.ts",
      "src/format.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date']",
          message:
            "Wall-clock `new Date()` is banned in indexing code — derive time from the event (block.timestamp).",
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            "`Date.now()` is banned in indexing code — derive time from the event (block.timestamp).",
        },
        {
          selector: "CallExpression[callee.name='Date']",
          message:
            "`Date()` is banned in indexing code — derive time from the event (block.timestamp).",
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: "`Math.random()` is banned in indexing code — handlers must be deterministic.",
        },
        {
          selector: "MemberExpression[object.name='process']",
          message:
            "`process.*` is banned in indexing code — handlers must be pure functions of chain events.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["crypto", "node:crypto"],
              message: "Crypto randomness is banned in indexing code — handlers must be deterministic.",
            },
          ],
        },
      ],
    },
  },
];
