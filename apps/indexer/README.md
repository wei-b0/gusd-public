# @gusd/indexer

Ponder-based onchain indexer for the gUSD protocol. Turns chain events into
**onchain protocol history + derived read state** in an isolated Postgres
schema, exposed to the app through the oracle Fastify API (`/v1/protocol/*`).

Reads `apps/contracts/deployments/<chainId>.json` for addresses and a
`startBlock` anchor; canonical v4 pool ids are derived at boot
(`issuance.gpuIds()` → `tokenOf` + `poolParamsOf` → `keccak256(abi.encode(poolKey))`)
so the shared PoolManager/PositionManager sources are **filtered at fetch time**
on their indexed pool `id` — non-protocol pools cost nothing.

## What it owns (and what it doesn't)

| In scope | Out of scope |
| --- | --- |
| Protocol event history (mints, redeems, issuance, trades, fees, oracle publications) | Benchmark prices / OHLC / candles (`public.*` via the existing pipeline — authoritative) |
| Derived read state (pools, GPU assets, wallet balances, cost basis, stats) | Any frontend display price — indexed oracle values are transparency/health only |
| `user_events` evidence stream backing the web `IndexerPort` | Freshness-critical execution inputs (quotes, allowances, staleness gate) — stay on RPC |

## Schemas

- `INDEXER_DEPLOYMENT_SCHEMA` (e.g. `gusd_index_dev_v2`) — immutable history
  per deployment. A schema change = a new `v<n+1>`, a fresh backfill, and
  `ponder db prune` of the old.
- `INDEXER_VIEWS_SCHEMA` (e.g. `gusd_index_dev`) — stable SQL views the oracle
  API reads; auto-repoints to the new deployment once its backfill completes.

`public.*` (market data) is never touched.

## Determinism

Handlers are pure functions of events processed in chain/log order — no
`Date.now()`, no RNG, no process state (lint-enforced for `src/handlers/**`,
`src/projections/**`, `src/events.ts`, `src/format.ts`). A full re-backfill is
byte-identical; reorgs roll back and replay through Ponder's transaction log
and delta-based counters converge.

## Development

```sh
pnpm stack:up                       # postgres on :54329
cd apps/contracts && anvil       # chain on :8545
forge script Deploy && forge script Demo   # or via the repo's usual flow
pnpm dev:indexer                 # ponder dev (hot reload; drops tables on schema edits)
curl localhost:42069/ready       # 200 once realtime
```

Copy `.env.example` → `.env.local` (Ponder loads it at CLI boot). Only the RPC
URL is mandatory in dev.

## Environment

| Variable | Meaning |
| --- | --- |
| `INDEXER_DATABASE_URL` | Postgres (falls back to `DATABASE_URL`, then the house default) |
| `INDEXER_DEPLOYMENT_SCHEMA` / `INDEXER_VIEWS_SCHEMA` | Per-deployment history / stable views |
| `INDEXER_CHAINS` | Comma-separated chain ids (one active chain per environment) |
| `INDEXER_RPC_URL_<id>` | Required for every listed chain |
| `INDEXER_MAX_BLOCK_RANGE_<id>` | Optional `eth_getLogs` cap (rate-limited endpoints) |
| `INDEXER_DEPLOYMENTS_DIR` | Override the deployments dir (containers) |
| `PORT` | Ponder's HTTP (health/ready/status/metrics) — private network only |

## Testing

- `pnpm test` — unit tests (pure projections, network-free).
- `pnpm test:anvil` — gated integration suite (private anvil + Deploy + Demo;
  asserts SQL read models, wire conformance, reorg rollback, byte-identical
  re-backfill, views rotation). Boots its own anvil on :18545 and its own
  `ponder start` instances in `gusd_index_e2e_*` scratch schemas — never
  touches the dev chain or dev schemas.
