<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Environment modes

All vars are documented in `.env.example`. The modes that matter:

- **No `NEXT_PUBLIC_PRIVY_APP_ID`** — demo/CI shape: the app builds and runs with
  the prototype session (`mock` auth), no wallet code mounts. Build stays network-free.
- **Privy configured** — real auth. Server-only secrets (`PRIVY_APP_ID`,
  `PRIVY_APP_SECRET`, `PRIVY_VERIFICATION_KEY`) are read by the route handlers
  via `src/server/env.ts`; they must never get the `NEXT_PUBLIC_` prefix.
- **Chain** — `NEXT_PUBLIC_CHAIN_ID` (default `31337` Anvil) selects the one
  active chain; remote chains also require their `NEXT_PUBLIC_RPC_URL_<id>`.
- **`NEXT_PUBLIC_ENABLE_TX_DEV=1`** — mounts the dev-only Transactions panel
  (panel 99) for driving the full tx lifecycle against Anvil.
- **`NEXT_PUBLIC_INDEXER_URL`** — the Ponder indexer's base URL. ABSENT (the
  default) ⇒ the indexer client is inert: zero network calls, user state comes
  from direct contract reads, and session ledgers keep "this session"
  provenance. The wire contract lives in `src/domain/indexer.ts`.

Gated test suites: `RUN_DB_TESTS=1` (needs the `gusd-postgres` container) runs
the route-handler and identity integration tests; `RUN_ANVIL_TESTS=1` (needs a
local `anvil` node on 8545) runs the tx-lifecycle verification in
`src/data/web3/tx-store.anvil.test.ts`. Both default to skipped so CI stays
network-free.

