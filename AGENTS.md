# AGENTS.md

## Purpose

This is the gUSD monorepo: a GPU-hour-backed stablecoin protocol. An
offchain benchmark oracle computes GPU-hour prices from live provider data,
a publisher writes them to the onchain `GPUPriceOracle`, an indexer turns
protocol events into queryable Postgres views, and a trading-desk web app
(issuance, pools, staking) runs on top. pnpm@11.25.0 + Turborepo, Node ≥ 24,
Foundry for the contracts, Uniswap v4 for the GPU markets.

Per-directory rules live in `apps/contracts/AGENTS.md` (read
`apps/contracts/PROTOCOL.md` before touching contracts) and
`apps/web/AGENTS.md` (web env modes and the indexer boundary).

## Layout

| Path | What it is |
| --- | --- |
| `apps/contracts` | Foundry: GUSD, GPUIssuance, GPUMarketLiquidity, GPUToken, RevenueLedger, sgUSD, GPUHook, GpuRouter, GpuQuoter, StableRouter, `GPUPriceOracle`. `deployments/<chainId>.json` is the one shared address record |
| `apps/oracle` | Fastify price API: collectors → benchmark engine → `/v1/prices*`, `/v1/providers`, `/v1/health`, WS `/v1/stream`, SSE `/v1/stream/sse`. Also proxies the indexer as `/v1/protocol/*` (registered only when `INDEXER_SCHEMA` is set) |
| `apps/publisher` | oracle → `GPUPriceOracle.publish()` loop, gated by PROTOCOL.md §11 |
| `apps/indexer` | Ponder: chain events → `gusd_index_*` Postgres schemas. Its HTTP surface stays private to the compose network — reachable only through the oracle's `/v1/protocol` proxy |
| `apps/web` | Next.js trading desk — the only component NOT containerized |
| `packages/db` | Drizzle schema, migrations, append-only triggers, repos |
| `packages/pricing-engine` | the methodology: pure `computeIndex` + versioned, allowlist-validated config |
| `packages/collectors` | 20 provider collectors + ECB FX + watchdog feeds; thin I/O, pure parsers |
| `packages/collector-kit` | scheduler lanes, timeout/retry, circuit breaker |
| `packages/normalize`, `packages/gpu-catalog`, `packages/types`, `packages/eslint-config`, `packages/typescript-config` | label normalization + catalogue, shared types, tooling |
| `infra/` | `docker-compose.yml` (postgres, db-migrate, indexer, oracle, publisher) + `.env.example` |

One Postgres serves everything (host port 54329): `public.*` is the oracle's
market data — the authoritative source for every displayed price — and
`gusd_index_*` is Ponder's protocol history + derived views. The indexer
never touches `public.*`; benchmark prices never come from the indexer URL.

## The asset universe

`SETTLEMENT_PANELS` in `packages/gpu-catalog/src/catalog.ts` is the single
upstream source of truth. Exactly four settlement panels:

```text
H100_PANEL_V1     → H100_SXM_80GB
H200_PANEL_V1     → H200_141GB
L40S_PANEL_V1     → L40S_48GB
RTX_4090_PANEL_V1 → RTX_4090_24GB
```

Everything derives from that constant by import, never by mirroring: the
oracle engine/replay/server, the publisher's watched list, and the web app's
`ORACLE_PANELS` all read it from `@gusd/gpu-catalog`.

- The broader `CATALOG` in the same file (27 SKUs — A100, B200, B300, GB200,
  GB300, …) is collection breadth only. Old SKUs remain collectable and
  normalizable, but they are not settlement panels, not onchain tokens, not
  tradable product assets — no candidates are computed for them.
- Onchain, `Deploy.s.sol` registers exactly the four launch SKUs (canonical
  posture). `Deploy.full.s.sol` runs `Deploy` unchanged, then adds genesis
  inventory, quoter floats, demo activity, and a deterministic mock USDT
  (`stables[1]`, `0xAd8F…8AFE`, pinned in the web's `stables.ts`). The chain
  it produces is non-virgin — `Demo.s.sol` requires virgin state.
- Protocol-side canon: `apps/contracts/PROTOCOL.md` §3. Offchain canon:
  `docs/oracle/METHODOLOGY.md` and `docs/oracle/PROVIDERS.md`.

## Methodology (v0.4.0)

`DEFAULT_METHODOLOGY_CONFIG` in `packages/pricing-engine/src/config.ts`
(version `0.4.0`) is the live methodology; `docs/oracle/METHODOLOGY.md`
specifies it exactly. Thresholds live in config, never in code — a
methodology change is a new version row, never a mutation, and configs are
validated by an exhaustive allowlist before they can drive a computation.

Thin-panel overrides (an override may only *relax* gates, and only
`COLLECTED` providers can be promoted, per panel):

- `L40S_PANEL_V1` — promotes `datacrunch`, `scaleway`, `coreweave`;
  `minProviders: 3`, `requireExecutable: false`. Temporary until executable
  L40S order books deepen.
- `RTX_4090_PANEL_V1` — promotes `akash`; `minProviders: 3`,
  `requireExecutable: true` (executable floor kept).
- H100/H200 settle under the untouched global gates (quorum 4, executable
  required).

A panel computing below the global quorum publishes `degraded` at best,
never `healthy`. The v0.3.0 publishing movement allowance lets the published
figure carry a bounded (±0.05%) mean-reverting offset around the computed
anchor so rate-card-settled panels print a moving series; the anchor itself
is never moved by it.

## Publisher posture (PROTOCOL.md §11 — liveness-first)

The publisher (`apps/publisher`) polls the oracle's `index_candidates`,
audits each latest candidate, and keeps the on-chain price current: publish
on a deviation ≥ `PUBLISHER_MIN_DEVIATION_PCT` (default 0.5) vs the last
published figure, or after `PUBLISHER_HEARTBEAT_MS` (default 24h) — whichever
first. Quality verdicts (quorum, dispersion, band, staleness, jump,
source-health breakers) are **non-blocking audit annotations** recorded to
`publish_violations` — a numeric price always publishes (a `withheld`
candidate publishes too, annotations riding along). The sole hard stop
is a null price — a candidate with no numeric price publishes nothing.
`candidate
flagged` in `docker logs gusd-publisher` means "published anyway, here's why
a human should look".

The compose stack defaults to `PUBLISHER_TARGET=chain` against the local
Anvil posture (account #0 key — a public dev key, injected by compose;
override the whole block in `infra/.env` for remote chains).
`PUBLISHER_TARGET=mock` runs the pipeline without any chain. The `chain`
target aborts boot loudly on a chain-id / `PRICE_SCALE` / publisher
mismatch.

## Commands

```sh
pnpm install                       # corepack enable for pnpm 11.25.0
./start-dev.sh [--build]           # the whole local posture in one command
./stop-dev.sh [--volumes]          # --volumes wipes Postgres (asks first)
```

`./start-dev.sh` = fresh Anvil on :8545 + full `Deploy.full` redeploy
(addresses rotate every run; stale broadcast/cache wiped; ~140 txs) + Ponder
schema drop + compose backend up with the publisher's oracle address
injected + web `abi:sync` + a health/4-canonical-pools data barrier.
`--build` rebuilds the docker images (`gusd-indexer:local`,
`gusd-oracle:local`, `gusd-publisher:local`); by default the stack reuses
the prebuilt images, so **run `./start-dev.sh --build` after editing
indexer/oracle/publisher code**. Phase failures leave the chain/containers
up on purpose; logs land in `${TMPDIR:-/tmp}/gusd-dev`.

```sh
pnpm stack:up / pnpm stack:down    # compose backend only (stack:up injects
                                   # the record's oracle address)
pnpm --filter @gusd/web dev        # web dev server (manual; → localhost:3000)
pnpm --filter @gusd/web abi:sync   # regenerate web addresses from the record
pnpm test / lint / check-types / build   # turbo, all workspaces
pnpm dev:oracle / dev:publisher / dev:indexer   # host-run single services
pnpm replay                        # offline replay: fixtures → DB → API
pnpm replay:verify                 # byte-compare audit of stored candidates
pnpm db:generate / pnpm db:migrate # drizzle schema / migrate
pnpm web:fixture                   # zero-dep mock oracle fixture server (:8081)
```

- `apps/web/.env.local` (gitignored, once per clone) needs
  `NEXT_PUBLIC_ORACLE_URL=http://127.0.0.1:8080` and
  `NEXT_PUBLIC_INDEXER_URL=http://127.0.0.1:8080/v1/protocol`.
- Backend overrides live in `infra/.env` (gitignored; shape in
  `infra/.env.example`): ports, indexer schemas, chains, collector API keys,
  publisher posture.
- A root `pnpm dev` starts host-run oracle/publisher/indexer too — that
  collides with the containers. A host-run `dev:oracle` on :8080 shadows the
  container's oracle; `start-dev.sh` kills such shadows (and stale anvils on
  :8545) before starting.
- The deployment record `apps/contracts/deployments/<chainId>.json` is the
  single address record: the indexer reads it at boot from a read-only mount
  (`docker compose restart indexer` picks up a redeploy without an image
  rebuild), the web regenerates from it via `abi:sync`, and `stack:up`
  injects its `.oracle` into the publisher.

### Contracts

```sh
cd apps/contracts
forge test                # full Foundry suite (test:verbose = -vvv)
forge snapshot            # gas snapshot
```

Deploy recipes (Anvil account #0 key is a public dev key, local posture
only):

```sh
# Full-app posture: production Deploy + genesis inventory + demo activity
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  forge script script/Deploy.full.s.sol --rpc-url http://127.0.0.1:8545 \
  --broadcast --sig "runFull()"
```

Minimal flow-testing (`Deploy` + `Demo`) needs a virgin chain — it will not
run after `Deploy.full`. Wipe stale `broadcast/` + `cache/` before
redeploying on a reset chain.

## Tests and gating

Default `pnpm test` is network-free and skips the gated suites. Turbo's
`test` task depends on `^build` — workspace tests resolve through built
`dist/`, so rebuild (or run via turbo) after editing package sources.

- `RUN_DB_TESTS=1` (needs the `gusd-postgres` container on :54329) runs the
  DB-backed suites: `packages/db` integration tests, publisher
  `db.integration`, oracle e2e (replay → API → WS/SSE), and the web
  route-handler/identity integration tests.
- `RUN_ANVIL_TESTS=1` (needs a local anvil on :8545) runs the web
  tx-lifecycle tests and the indexer anvil e2e.
- Both vars are declared in `turbo.json` `globalEnv`.

CI (`.github/workflows/ci.yml`) mirrors this: a network-free `core` job
(collectors run against recorded fixtures only; `@gusd/contracts` excluded,
tracked separately) and a `database` job with `RUN_DB_TESTS=1` against a
Postgres 16 service.

## Data discipline

- Market-data tables are append-only, enforced by Postgres triggers
  (`raw_observations`, `normalized_observations`, `provider_prices`,
  `index_candidates`, `published_index_values`, `source_failures`,
  `fx_rates`, `publish_violations`). Never mutate or disable the triggers —
  if a write pattern collides with append-only, surface the problem and
  prefer age-out over schema surgery.
- Raw observations are immutable; every derived row carries the inputs that
  produced it (candidates carry receipts; the replay byte-compare audit
  depends on this).
- Indexer schemas rotate: `gusd_index_<env>_v<n>` (deployment history) +
  `gusd_index_<env>` (stable views). A schema change = a new `v<n+1>` and a
  fresh backfill — Ponder cannot resume across a chain reset or schema
  rotation.

## Docs map

- `apps/contracts/PROTOCOL.md` — the protocol specification (canonical)
- `docs/oracle/METHODOLOGY.md` — index methodology v0.4.0, as configured
- `docs/oracle/ARCHITECTURE.md` / `PROVIDERS.md` / `RESEARCH.md` — the
  benchmark pipeline and the collection matrix (20 providers + ECB FX +
  2 watchdog feeds; roles: settlement-eligible / collected / watchdog / excluded)
- `docs/indexer/ARCHITECTURE.md` + `apps/indexer/README.md` — indexing design and ops