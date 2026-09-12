# gUSD Indexer Architecture

The indexer turns protocol events into event history and derived read state.
Envio HyperIndex 3.10.0 owns a dedicated
`gusd_index_envio_<environment>_v<n>` Postgres schema. The oracle queries the
native entity tables and preserves the existing `/v1/protocol/*` response
contracts. Benchmark prices and candles remain in `public.*` and are the only
authoritative display prices.

## Data path

```text
Robinhood mainnet 4663 ── HyperSync ──┐
Anvil 31337/46630 ─────── RPC ────────┼─ Envio handlers ─ Postgres entities
                                      └─ /metrics, /healthz
Postgres entities ─ oracle SQL ─ /v1/protocol/* ─ web
```

Mainnet requires a HyperSync token and may use RPC as fallback. Each process
indexes one chain. Reorg rollback is enabled with depth 10,000 on mainnet and
200 on Anvil, with zero block lag.

## Generated configuration

At startup, `scripts/generate-config.ts` reads the mounted deployment record
and emits the ignored `config.yaml` and `src/runtime-config.ts` files.
`scripts/emit-abis.ts` derives ABI JSON from the trimmed TypeScript ABIs.
Addresses live under each chain contract in the generated Envio configuration;
event filters are registered in TypeScript.

The process indexes the deployment record's `startBlock`. GPUToken addresses
are registered dynamically from `GpuCreated`. Mainnet PoolManager and
PositionManager registrations apply canonical pool-id topic filters derived
from the deployment.

## Storage

The GraphQL schema defines 38 per-chain entities: immutable event rows keyed by
block and log identity, plus projections keyed by their natural identifiers.
Addresses and transaction hashes are lowercase. Integer accounting stays exact
and API amounts remain decimal strings.

Envio owns its event, projection, checkpoint, and history tables so it can
reverse a reorg transactionally. The market-data append-only rules apply only
to `public.*`; the indexer never accesses those tables.

## Projection rules

Handlers preserve chain and log ordering, first-insert deltas, wallet underflow
checks, weighted cost basis, vault accounting, and canonical-pool guards.
Preload reads remain enabled. Writes are collected in an in-memory overlay
during preload and committed through generated entity APIs during the commit
pass, preserving dependencies between events in the same batch.

The main read models are pools, GPU assets, oracle state, wallet balances,
wallet cost basis, vault positions, user events, hourly pool statistics, daily
protocol statistics, protocol totals, and the sgUSD vault singleton.

## Oracle boundary

The oracle uses explicit quoted mappings from API concepts to Envio's native
entity tables and columns. Every query remains schema-qualified and scoped to
the configured chain. Pagination, ordering, nullability, and decimal-string
amounts are normalized at this boundary; Envio's generated column names (for
example the v4 pool's `sqrt_price_x96`) are consumed verbatim.

Indexer health reads native `/metrics`, extracts committed progress and
readiness for the configured chain, then obtains that block's timestamp from a
cached RPC call. Probes cache for five seconds and use two-second network
timeouts. Missing metrics, tables, or RPC data degrade only the indexer section
of oracle health.

## Recovery

Restarting with an unchanged schema resumes from Envio checkpoints. A chain
reset, deployment rotation, or entity-schema change uses a fresh selected
schema and reindexes from the deployment block. There are no compatibility
views, Ponder fallback, shadow deployment, or retained Ponder schemas.

`start-dev.sh` stops indexing before resetting chain-derived schemas, deploys
the fresh contract record, starts Envio and the oracle together, and waits for
healthy indexing plus all four canonical pools. It preserves `public.*` market
data and migration journals.

## Verification

The network-free suite covers projections and serialization. The gated Anvil
suite deploys into a private chain and checks pinned accounting, independent
byte-identical backfills, unchanged-schema restart, and a live reorg that must
remove reverted event rows and restore affected projections without an indexer
restart or schema wipe.
