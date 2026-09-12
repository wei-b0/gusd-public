# gUSD

A GPU-hour-backed stablecoin protocol. An offchain benchmark oracle computes
GPU-hour prices from live provider data, a publisher writes them to the
on-chain `GPUPriceOracle`, an indexer turns protocol events into queryable
Postgres views, and a trading desk web app (issuance, pools, staking) runs on
top. pnpm + Turborepo monorepo; Foundry for the contracts.

```
apps/contracts   Foundry: GUSD, GPUIssuance, GPUPriceOracle, routers, hook,
                 deployments/<chainId>.json (the shared address record)
apps/oracle      Fastify price API — collectors → benchmark → /v1/prices*
apps/publisher   oracle → GPUPriceOracle publish loop (methodology-gated)
apps/indexer     Envio HyperIndex — chain events → native Postgres entities
apps/web         Next.js trading desk (the only component NOT containerized)
packages/        db (drizzle), pricing-engine, collectors, normalize, types …
infra/           docker-compose stack + env files
```

## The stack

`infra/docker-compose.yml` is the whole backend. One Postgres serves both the
oracle's `public.*` market data and Envio's `gusd_index_envio_*` schemas; Envio's
HTTP surface stays private to the compose network and is reachable only
through the oracle's `/v1/protocol` proxy.

| service     | what it is                                                    | host port |
| ----------- | ------------------------------------------------------------- | --------- |
| postgres    | the one Postgres                                              | 54329     |
| db-migrate  | one-shot drizzle migrations (runs on every `up`, journaled)    | —         |
| indexer     | Envio; generates config from `deployments/<id>.json` at boot  | — private |
| oracle      | `/v1/prices*`, `/v1/protocol` proxy, `/v1/health`              | 8080      |
| publisher   | publishes the benchmark to `GPUPriceOracle` (chain by default) | —         |

> One-command posture: `./start-dev.sh` (fresh Anvil + full `Deploy.full`
> redeploy + backend containers; `--build` builds the images on demand) and
> `./stop-dev.sh` (`--volumes` also wipes Postgres). The rest of this README
> is the manual path those scripts encode.

## Prerequisites

- Docker Desktop
- Node ≥ 24 + pnpm (`corepack enable`; `packageManager` pins pnpm 11.25.0)
- Foundry (`anvil`, `forge`) for the local chain

## From scratch

```sh
pnpm install
```

Start the chain and deploy the full catalogue (seeds the four launch SKUs,
mock USDT, the stable pool, and demo activity — primary buys capitalize each
market's bid bands, so the web app has data the moment it opens).
Use anvil account #0: Deploy defaults the on-chain publisher to the deployer,
and that is the key the stack's publisher container uses.

```sh
anvil   # terminal 1
```

```sh
# terminal 2
cd apps/contracts
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  forge script script/Deploy.full.s.sol --rpc-url http://127.0.0.1:8545 \
  --broadcast --sig "runFull()"
```

Bring up the backend (first run builds the images — slow, once). This also
injects the deployed oracle address from the deployment record into the
publisher; a redeploy plus a plain re-run re-syncs it.

```sh
pnpm stack:up
```

Point the web app at the stack (gitignored, once per clone) and run it:

```sh
cat >> apps/web/.env.local <<'EOF'
NEXT_PUBLIC_ORACLE_URL=http://127.0.0.1:8080
NEXT_PUBLIC_INDEXER_URL=http://127.0.0.1:8080/v1/protocol
EOF

node apps/web/scripts/abi-sync.mjs   # regenerate addresses from the record
pnpm --filter @gusd/web dev          # → http://localhost:3000
```

> Run the web app with its filter — a root `pnpm dev` starts host-run
> oracle/publisher/indexer too, which collides with the containers.

Verify:

```sh
docker compose -f infra/docker-compose.yml ps
curl -s http://127.0.0.1:8080/v1/health | head -c 200
# the indexer subsection flips "degraded" → "healthy" once backfill
# reaches realtime; indexed surfaces in the app come alive then
```

## Redeploy ritual (fresh / reset chain)

The chain was reset under an existing index? Drop the selected Envio schema
first; an indexer cannot resume checkpoints across a chain reset:

```sh
docker exec gusd-postgres psql -U gusd -d gusd \
  -c 'DROP SCHEMA gusd_index_envio_docker_v1 CASCADE;'
```

Then: redeploy (step above) → `pnpm stack:up` → `docker compose restart
indexer` (the mounted record is re-read) → `node apps/web/scripts/
abi-sync.mjs`.

## Day-2 knobs

- `pnpm stack:down` / `pnpm stack:up` — stop / start the backend
- `docker compose restart <service>` — e.g. pick up a new deployment record
- `docker logs <container>` — e.g. `gusd-publisher` shows publishes, flags
  and gas-saving suppressions
- Overrides live in `infra/.env` (gitignored; shape in `infra/.env.example`):
  ports, schemas, chains, collector API keys, publisher posture. The
  publisher defaults to CHAIN on the local Anvil posture (account #0 key — a
  public dev key); remote chains override the whole block, and
  `PUBLISHER_TARGET=mock` runs the pipeline without any chain. The §11
  trigger is tunable via `PUBLISHER_MIN_DEVIATION_PCT` (default 0.5) and
  `PUBLISHER_HEARTBEAT_MS` (default 24h).

## What to expect

- The oracle serves **live benchmark data** scraped from real provider APIs —
  not the deployment seed prices. The publisher keeps the on-chain price
  current per PROTOCOL.md §11: it publishes when a candidate deviates ≥0.5%
  from the last published figure, or every ~24h heartbeat. Quality verdicts
  (quorum, dispersion, band, staleness…) are recorded non-blocking to
  `publish_violations` for audit — `candidate flagged` in `docker logs
  gusd-publisher` means "published anyway, here's why a human should look".
- Deployment addresses live in ONE file —
  `apps/contracts/deployments/<chainId>.json`. The indexer reads it at boot,
  the web regenerates from it via `abi-sync`, and the publisher gets its
  oracle address injected from it by `pnpm stack:up`.

## Docs

- `apps/contracts/PROTOCOL.md` — the protocol specification
- `docs/oracle/` — benchmark methodology, providers, architecture
- `docs/indexer/ARCHITECTURE.md` — indexing design
- `apps/indexer/README.md` — indexer ops
