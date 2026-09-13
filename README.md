# gUSD

**The GPU Assets Protocol.**

gUSD creates onchain spot markets for exposure to GPU compute prices. The protocol combines a live GPU-hour benchmark, oracle-priced primary issuance, Uniswap v4 markets, protocol-owned market liquidity, a reserve-backed settlement asset, and a savings layer.

**Live:** [gusd.lol](https://gusd.lol)  
**Network:** Robinhood Chain mainnet · chain ID `4663`

## What gUSD is

The protocol has three core asset layers:

- **gUSD** — the protocol settlement asset. On Robinhood Chain, gUSD is backed 1:1 by USDG.
- **GPU assets** — fungible ERC-20 assets representing the economic value of one hour of a specific GPU configuration.
- **sgUSD** — a non-rebasing savings/revenue-sharing vault for gUSD.

The launch settlement universe is intentionally small:

| Market | Canonical GPU |
| --- | --- |
| H100 | `H100_SXM_80GB` |
| H200 | `H200_141GB` |
| L40S | `L40S_48GB` |
| RTX 4090 | `RTX_4090_24GB` |

The broader oracle catalogue contains additional GPUs for collection and research, but only these four are settlement panels, onchain GPU assets, and tradable protocol markets at launch.

## Protocol architecture

```text
GPU rental markets
        │
        ▼
collectors + normalization
        │
        ▼
GPU benchmark / oracle API
        │
        ▼
publisher ───────────────► GPUPriceOracle
                              │
                              ▼
USDG ──► gUSD ──► primary GPU issuance
  │          │              │
  │          │              └──► GPU tokens
  │          │                    │
  │          │                    ▼
  │          └──────────────► Uniswap v4 markets
  │                               │
  │                               ├── GPUHook
  │                               └── protocol-owned liquidity
  │
  └── 1:1 reserve backing

gUSD ──► sgUSD
          ▲
          └── protocol revenue
```

### gUSD

gUSD is fully reserve-backed by one canonical reserve asset per chain. On Robinhood Chain that reserve asset is **USDG**.

```text
1 USDG ↔ 1 gUSD
```

Additional owner-whitelisted stables can route through `StableRouter`; they are swapped into the canonical reserve before gUSD is minted. The reserve remains a single backing asset.

### GPU primary issuance

GPU supply starts at zero. Creating new GPU-token supply requires gUSD at the oracle reference price plus the configured issuance fee.

The principal is **not** kept in a redemption vault. It becomes market capital for that GPU and is deployed by `GPUMarketLiquidity` as protocol-owned bid-side liquidity around the current oracle reference.

```text
gUSD
  │
  ▼
GPUIssuance
  ├── principal ──► GPUMarketLiquidity ──► oracle-anchored v4 liquidity
  ├── fee ────────► protocol revenue
  └── GPU token ──► user
```

A GPU token therefore has no protocol promise of oracle-NAV redemption. Holders realize gains or losses through the market.

### Uniswap v4 + GPUHook

Each launch GPU trades against gUSD through a canonical Uniswap v4 pool.

The protocol reuses Robinhood Chain's canonical v4 infrastructure rather than deploying a second PoolManager. `GPUHook` supplies GPU-specific execution logic, while the canonical v4 pools remain the settlement venue.

The launch configuration does not require third-party LP depth. Primary issuance capital creates protocol-owned market depth, and `GPUMarketLiquidity` can recenter that inventory around a moving oracle reference.

Ordinary secondary trading does **not** mint or burn GPU assets:

- **BUY** — consumes existing market inventory when available; primary issuance supplies new inventory when required by the protocol path.
- **SELL** — sells GPU inventory into available market depth.
- **Recenter** — permissionlessly re-anchors protocol-owned liquidity around a fresh oracle reference.

### Oracle

The oracle pipeline collects and normalizes live GPU rental-market data, computes versioned benchmark panels, persists an auditable price history, and exposes the current benchmark through the oracle API.

The publisher writes benchmark changes to `GPUPriceOracle`.

Current committed publication policy:

- benchmark evaluation: ~15 seconds
- publish when deviation is at least **0.5% / 50 bps**
- heartbeat: ~24 hours
- quality violations are recorded as non-blocking audit annotations
- a candidate with no numeric price is the hard stop

The onchain oracle is the execution reference. Historical/time-series application data comes from the protocol's database and indexer surfaces.

## Mainnet deployment

**Status: deployed on Robinhood Chain mainnet (chain ID `4663`).**

Deployment start block: **`61390610`**

### gUSD protocol contracts

| Contract | Address |
| --- | --- |
| gUSD | `0xAE52d24C85d0261A161B3bE0b444055BD80471F7` |
| sgUSD | `0x091a94DBc3E90df51364163047E6A81724dCc4a9` |
| GPUPriceOracle | `0x8CC5b5d1f7334B56e948e12bA7A759F24eA0681c` |
| Oracle publisher | `0xfEed079814cB1fFd2E7aECd3A991A78309e0b5e8` |
| GPUIssuance | `0x7506b03E9A4aD1C6FBBd3E1c355bb76d0462aA6e` |
| GPUHook | `0xf60Aa9Cf9720236E51C1D02FF9Cd685FC2b510cC` |
| GPUMarketLiquidity | `0xB42045b03a6b5EDBbBA335A01fCb7cA93c2DA4f7` |
| RevenueLedger | `0x64e3FeE2AB83E0b1E3F6a14eC872e8a7a8253C1a` |
| GpuRouter | `0x9a7348d8Fb6C628889B2e9c2B5BD8fB1FF6F474a` |
| GpuQuoter | `0x9207F55b00b16B6dA00aC977CFB4039f482F9158` |
| StableRouter | `0xc5fe369D2C313B10B2a1971bCA32D3204283dBEc` |

### Reserve

| Asset | Address |
| --- | --- |
| USDG / underlying | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

The current stable allowlist contains the reserve asset above.

### Reused Robinhood Chain / Uniswap v4 infrastructure

| Contract | Address |
| --- | --- |
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| V4 Quoter | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` |
| StateView | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |

The production deployment reused Robinhood Chain's canonical v4 contracts so gUSD markets settle against the chain's existing PoolManager instead of fragmenting liquidity across a second v4 deployment.

## Repository

gUSD is a pnpm + Turborepo monorepo. Contracts use Foundry.

```text
apps/
  contracts/     Solidity protocol, Uniswap v4 hook, routers and deploy scripts
  oracle/        Fastify benchmark/oracle API
  publisher/     offchain → GPUPriceOracle publication loop
  indexer/       Envio HyperIndex protocol indexer
  web/           Next.js trading application

packages/
  collectors/        provider integrations
  collector-kit/     scheduling, retry and circuit-breaker primitives
  pricing-engine/    versioned GPU benchmark methodology
  gpu-catalog/       canonical GPU catalogue + settlement panels
  normalize/         provider/GPU normalization
  db/                Drizzle schema, repositories and migrations
  types/             shared types

infra/
  docker-compose.yml
```

### Data plane

One Postgres deployment serves two intentionally separate domains:

- `public.*` — oracle market data and benchmark history
- `gusd_index_envio_*.*` — indexed onchain protocol events and derived state

The oracle is authoritative for benchmark prices. Envio is authoritative for indexed protocol history. The oracle service exposes the indexer's read surface through `/v1/protocol/*`.

Chain `4663` uses **Envio HyperSync** for event synchronization, with RPC available for fallback/status reads.

### Web

The web application is built with Next.js and Privy.

Privy provides embedded/self-custodial wallets for users who authenticate with Web2 login methods, while externally connected wallets can be used directly as the user's onchain account.

The application consumes:

- the oracle API for benchmark and historical market data
- indexed protocol state through `/v1/protocol/*`
- Robinhood Chain directly for execution and live contract reads

## Local development

Requirements: Docker, Node >= 24, pnpm 11.25.0, and Foundry.

The fastest full-stack development path is:

```sh
pnpm install
./start-dev.sh --build
pnpm --filter @gusd/web dev
```

`start-dev.sh` starts a fresh Anvil chain, runs the full development deployment, resets the local Envio schema, brings up Postgres/oracle/publisher/indexer, syncs contract addresses into the web app, and waits for the canonical markets to become readable.

For subsequent starts without backend source changes:

```sh
./start-dev.sh
```

Useful commands:

```sh
pnpm test
pnpm lint
pnpm check-types
pnpm build

pnpm dev:oracle
pnpm dev:publisher
pnpm dev:indexer

pnpm --filter @gusd/web abi:sync
pnpm --filter @gusd/indexer test
```

Contracts:

```sh
cd apps/contracts
forge test
forge snapshot
```

## Production services

The backend stack is containerized through `infra/docker-compose.yml`:

| Service | Role |
| --- | --- |
| Postgres | oracle data + isolated Envio schemas |
| db-migrate | Drizzle migrations |
| indexer | Envio HyperIndex; HyperSync on 4663 |
| oracle | benchmark API + protocol read proxy |
| publisher | submits fresh benchmark prices to `GPUPriceOracle` |

The Next.js web application is deployed separately.

## Protocol invariants

The V1 design is built around a few explicit boundaries:

- gUSD cannot be created without eligible reserve backing.
- GPU-token supply cannot increase without gUSD entering primary issuance.
- issuance principal becomes market capital; issuance fees become protocol revenue.
- protocol-owned market liquidity does not mint GPU inventory for itself.
- stale oracle data cannot be used for issuance or POL placement.
- GPU tokens do not have oracle-NAV redemption.
- oracle price and market price are distinct.
- LP capital is not the solvency backstop for GPU-token appreciation.
- gUSD supply and reserve backing are chain-local.

## Documentation

- `apps/contracts/PROTOCOL.md` — canonical protocol/economic specification
- `docs/mainnet-deploy.md` — Robinhood Chain production deployment runbook
- `docs/oracle/METHODOLOGY.md` — benchmark methodology
- `docs/oracle/ARCHITECTURE.md` — oracle architecture
- `docs/oracle/PROVIDERS.md` — provider/collector matrix
- `docs/indexer/ARCHITECTURE.md` — indexing architecture
- `apps/indexer/README.md` — Envio indexer operations
- `apps/contracts/README.md` — contract development and deployment notes

## Current scope

V1 is deliberately a spot protocol. It does not provide perpetuals, leverage, user short positions, lending markets, GPU-NAV redemption, algorithmic gUSD stabilization, or protocol-operated cross-chain gUSD.

Those are separate future products, not hidden assumptions in the V1 solvency model.
