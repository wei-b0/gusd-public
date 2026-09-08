# gUSD Indexer — Architecture

The indexer turns the protocol's onchain activity into **event history and
derived read state** in an isolated Postgres schema, exposed to the app through
the oracle Fastify API as `/v1/protocol/*`. It owns onchain protocol history —
trades, issuance, mints/redeems, fees, oracle publications, wallet state. It
never owns market data: benchmark prices, OHLC and candles stay exclusively in
the `public.*` pipeline (`docs/oracle/ARCHITECTURE.md`), which remains the sole
authoritative source for every displayed price.

## The pipeline

```
Chain (anvil :8545 / Robinhood 46630 / mainnet 4663)
  │  eth_getLogs — PoolManager/PositionManager sources FILTERED at fetch time
  │                to the protocol's canonical pool ids
  ▼
apps/indexer (Ponder 0.17.9, pinned exactly)
  │  src/handlers/*  — thin; decode + call pure projections
  │  src/projections/* — pure functions of events; NO clock, NO RNG,
  │                      NO process state (lint-enforced)
  ▼
Postgres db `gusd`
  ├─ gusd_index_<env>_v<n>   deployment schema — event + derived tables
  └─ gusd_index_<env>        STABLE VIEWS schema — auto-repoints on ready
  │                            ▲ read-only, schema-qualified SQL
  ▼                            │
apps/oracle Fastify :8080 ─────┘
  ├─ /v1/prices /candles /stream …   ← public.* (UNCHANGED, authoritative)
  ├─ /v1/protocol/*                  ← the stable views (this doc)
  └─ /v1/health.indexer ──2s──► INDEXER_INTERNAL_URL /ready + /status

apps/web — one API base (:8080) + direct RPC only for execution
  └─ contractReadsWithIndexer(): state reads via /v1/protocol/*,
     each with RPC fallback; execution paths always RPC
```

Ponder's own HTTP (`/health` `/ready` `/status` `/metrics`) stays on the
private network. The web app has exactly one API base — the oracle.

## The four price notions (never collapsed)

1. **Canonical benchmark price** — `public.index_candidates` via `/v1/prices`
   (offchain, authoritative, the only display price).
2. **Oracle published value** — `oracle_state` (onchain; transparency, health,
   comparison ONLY — never a display price).
3. **AMM execution state** — `pools.sqrtPriceX96/tick/liquidity` (and the
   derived `ammPriceGusd`, named as execution state).
4. **Actual executed trade price** — per-event: `Buy.paid/gpuOut`,
   `Sell.out/gpuIn`, `pm_swap` deltas — derived at API time, never stored.

## Sources and the canonical-pool filter

All addresses come from `apps/contracts/deployments/<chainId>.json` (loaded
via `INDEXER_DEPLOYMENTS_DIR`). Protocol contracts (GUSD, sgUSD, GPUIssuance,
GpuRouter, StableRouter, RevenueLedger, GPUHook, GPUPriceOracle) are indexed
whole. The two v4 singletons are **filtered at the source**:

- Canonical pool ids are computed at config load:
  `issuance.gpuIds()` → `tokenOf(gpuId)` + `poolParamsOf(gpuId)` → sorted
  `(gusd, gpuToken, fee, tickSpacing, hook)` → `keccak256(abi.encode(poolKey))`.
- `PoolManager` (Initialize/Swap/ModifyLiquidity/Donate) and `PositionManager`
  (ModifyPosition) take a Ponder `filter: [{ event, args: { id: [poolIds] } }]`
  per event — fetch traffic, sync work, decoding and handler invocations are
  all bounded by protocol activity, not by the chain's total v4 activity.
- GPUToken children are discovered via Ponder's
  `factory({ address: issuance, event: GpuCreated, parameter: "token" })`.

**A GPU created after the indexer deploys is not in the static filter.**
`GpuCreated`/`PoolRegistered` for an unfiltered pool logs a loud error;
the resolution is a redeploy with recomputed ids (governance-paced; see
"Rotation" below).

## Schemas

- `INDEXER_DEPLOYMENT_SCHEMA` (`gusd_index_<env>_v<n>`) — one per deployment.
  Restarting on the same schema resumes from Ponder's checkpoint. Schema
  changes = new `v<n+1>`, fresh backfill, views flip, `ponder db prune` of the
  old.
- `INDEXER_VIEWS_SCHEMA` (`gusd_index_<env>`) — SQL views created/repointed by
  Ponder once the deployment's backfill completes. The oracle reads ONLY this
  schema, so a redeploy is invisible to the API.

**Ownership**: the indexer owns its schemas completely. Event tables are
append-only *from indexing logic*; the Ponder runtime freely rewrites them for
reorg rollback and recovery. The `public.*` append-only triggers do not apply
here, and nothing in this app touches `public.*` or the `drizzle` ledger.

### Event history tables (PK `(chainId, blockNumber, logIndex)` unless noted)

`gusd_minted/redeemed`, `sgusd_deposited/withdrawn/seeded`, `gpu_created`,
`gpu_issued`, `router_buy/sell`, `stable_mint_via_swap`,
`stable_redeem_via_swap`, `revenue_distributed`, `hook_pool_registered`,
`hook_fee_accrued`, `hook_fees_harvested`, `oracle_price_published/overridden`,
`oracle_publisher_accepted`, `pm_pool_initialized/swap/liquidity_modified`,
`pm_donate`, `posm_position_modified`, `posm_transfer` (ERC-6909),
`token_transfer` (GUSD/sgUSD/GPUToken `Transfer`),
`pol_band_placed/removed`, `pol_recentred`, `pol_fees_collected`
(`pol_principal_pending` is deliberately unfetched — `gpu_issued.base`
accumulates the same amount in the same block).

### Derived read models

| table | purpose |
| --- | --- |
| `pools` | per-pool state + cumulatives; `canonical` flag persisted from `hook_pool_registered` |
| `gpu_assets` | per-GPU issuance/trade aggregates + POL fee sweeps (catalog metadata joined at the API, never from chain) |
| `liquidity_bands` | POL band placements per (pool, tick range) from `BandPlaced`/`BandRemoved` — one live row per range, history preserved |
| `oracle_state` | indexed oracle state (transparency only) |
| `wallet_balances` | authoritative protocol-token balances from `Transfer`s |
| `wallet_cost_basis` | protocol-attributable WAC basis, `basisState`-gated (below) |
| `wallet_vault_positions` | sgUSD stake position |
| `wallets` | 1 row = 1 wallet, chain-derived counters only |
| `user_events` | wallet-attributed evidence projection (the web wire contract) |
| `pool_stats_hourly` / `protocol_stats_daily` | bucketed series for charts |
| `protocol_stats` / `sgusd_vault` | singletons: protocol counters + config mirrors; vault aggregates |

All counters are **delta-based** (`+= event`), never absolute recomputes —
that, plus pure handlers, is what makes reorg rollback + replay converge.

## Determinism

No `Date.now()`, wall clock, RNG or process-level mutable state exists in
`src/handlers/**`, `src/projections/**`, `src/events.ts` or `src/format.ts`
(eslint-enforced). Serving-time computations (`ageSec`, `lagSec`, `seenAtMs =
blockTimestamp × 1000`) happen at the API boundary, never in handlers.
Consequence, asserted by the gated suite: **a full re-backfill into a fresh
schema is byte-identical** (canonical-JSON dump per table, Ponder bookkeeping
excluded), and restarting on an existing schema changes nothing.

## Cost basis (transfer-aware)

`wallet_balances` is the authoritative balance truth. `wallet_cost_basis` is
the economic attribution and is separately gated:

- acquisitions = `Issued` (cost = `base + fee`) and `Buy` (cost = all-in
  `paid`); disposals = `Sell` (`out` treated as gUSD-equivalent, 6-dec 1:1).
- Any GPUToken/sgUSD `Transfer` touching the wallet **outside** those protocol
  events demotes the wallet's `basisState` to `partial` — transfers never move
  basis, they remove its completeness.
- The API returns `avgEntry`/`realizedPnlGusd` **only when
  `basisState === "complete"`**; otherwise `null` + `basisState` + reason.
  Print "—", never precise wrong math. Unrealized PnL is computed at API time
  against a named price notion, never stored.

## Tape vs executions

One routed trade = one row in EACH of four tables, never merged:
`router_buy`/`router_sell` (the execution, with pool + issuance legs),
`pm_swap` (the AMM primitive — the Terminal tape), `gpu_issued` (the primary
leg), `hook_fee_accrued` (the fee). `/v1/protocol/pools/:id/swaps` and
`/v1/protocol/wallets/:address/executions` are separate endpoints and are
never UNIONed as independent trades. Pool volume never includes hook fees
(only `TradingFeeAccrued` carries them) and never includes router-only
issuance legs.

## user_events (the web seam)

Written by exactly 7 handlers via one pure `projectUserEvent()`; the closed
event set is `Minted, Redeemed, Issued, Buy, Sell, Deposit, Withdraw` with the
user resolved as Minted→`to`, Redeemed→`from`, Issued→`to`, Buy/Sell→
`recipient`, Deposit/Withdraw→`owner` (pinned by `apps/web/src/domain/indexer.ts`).
`data` jsonb carries bigints as strings and lowercased addresses. Rows hold
only chain-derived fields; the Fastify boundary maps `seenAtMs` and serves the
keyset-cursor page (`(blockNumber, logIndex) DESC`, base64url cursor).

## /v1/protocol/* (served by the oracle)

| endpoint | reads | serves |
| --- | --- | --- |
| `GET /user-events?address&fromBlock&events&limit&cursor` | `user_events` | the web `IndexerPort` wire contract, verbatim |
| `GET /wallets/:address/balances` | `wallet_balances` | replaces interim `contractReads.balances` (gusd/sgusd/GPU) |
| `GET /wallets/:address/positions` | `wallet_cost_basis`, `wallet_vault_positions` | Portfolio positions; PnL gated on `basisState` |
| `GET /wallets/:address/executions` | `router_buy/sell` | routed executions with legs |
| `GET /pools`, `/pools/:id`, `/pools/:id/swaps` | `pools`, `pm_swap` | AMM execution state; the swap tape |
| `GET /gpus`, `/gpus/:gpu` | `gpu_assets` | asset stats + registration-equivalent |
| `GET /stats` (+`/history`) | `protocol_stats(_daily)`, `sgusd_vault` | aggregates; the share price derives here |
| `GET /oracle/:gpu` | `oracle_state` | transparency/health/comparison only |

4xx responses are `{error}` — never silent substitution. Numerics are strings
at the DTO edge; bigints never reach `JSON.stringify`.

## Reorgs, recovery, rotation

- **Reorgs / crash recovery** — Ponder's trigger transaction log rolls back
  event AND derived tables to the common ancestor and replays; delta counters
  converge. The gated suite reverts a chain past a publication and asserts the
  reverted price is gone from history and state.
- **Deployment rotation** — new `v<n+1>` schema → `ponder start
  --schema=…_v<n+1> --views-schema=<stable>` → backfill → views auto-repoint
  on `/ready` → verify → `ponder db prune` the old. The oracle never notices.
- **Runbook: new GPU asset** — its pool id is not in the running indexer's
  filter. Create the new deployment schema (which recomputes ids at boot),
  rotate as above.

## Ops

- `apps/indexer/Dockerfile` (node:24-alpine, filtered pnpm install, ships
  `packages/typescript-config` because Ponder's vite-node resolves tsconfig
  `extends` at runtime) + `infra/docker-compose.yml` `indexer` service on the
  private network; healthcheck = `/health` (liveness — no restart loops during
  backfill); readiness/alerting via `/ready` + `/status` + `/metrics`.
- Oracle wiring: `INDEXER_SCHEMA` (the stable views schema) and
  `INDEXER_INTERNAL_URL` (Ponder's private base) → `/v1/health` carries an
  `indexer` subsection that degrades alone, never the oracle's own verdict.
- Compose caveat: `docker compose up` restarts postgres when network config
  changes, killing all clients — avoid while the dev stack runs.

## Testing

- **Unit** (network-free): pure projections against fixture events built from
  `broadcast/Demo.s.sol/31337/run-latest.json` — swap-sign classification in
  both currency orderings, WAC acquire/dispose + transfer demotion, bucket
  math, bigint→string codec, cursor round-trip, user resolution ×7.
- **Gated anvil suite** (`pnpm --filter @gusd/indexer test:anvil`): the
  harness boots a PRIVATE anvil (:18545) and a throwaway copy of
  `apps/contracts` in /tmp (so `forge script Deploy` cannot clobber the dev
  deployment file), runs `Deploy` + `Demo`, then drives its own
  `ponder start` instances in `gusd_index_e2e_*` scratch schemas. Asserts:
  index-to-realtime vs known demo flows, byte-identical fresh re-backfill,
  checkpoint-resume no-op, views rotation (definitions + identical counts),
  and reorg rollback of event + derived state.
- **Web seam**: `src/data/web3/reads-protocol.test.ts` — inert without env,
  hybrid balance mapping with chain filter, 404-as-data vs failure semantics,
  indexed rate math (6-dec shares), RPC fallback on any indexed failure.
