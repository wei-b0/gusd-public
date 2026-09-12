# Mainnet deploy — Robinhood Chain (4663)

The production deployment recipe. Every ingredient is real: the reserve
asset, the publisher identity, the treasury, the funding stables, the
seed prices. The testnet recipes (Deploy.full / Demo / IndexerDemo /
DeployMockOracle) **refuse to run here** — they deploy mock tokens, fund
public anvil keys and seed demo activity, none of which may ever be a
production chain's first transactions.

## 0) Inputs (collect before touching a terminal)

| Input | Where it goes | How to verify |
|---|---|---|
| Deploy key | `PRIVATE_KEY` (env, inline — never a file) | `cast wallet address` |
| Publisher key | `PUBLISHER` (address) + `PUBLISHER_PRIVATE_KEY` (infra) | A **separate key** from the deployer — it becomes the oracle's publish role at construction. Fund with gas. |
| Treasury address | `TREASURY` | Receives the non-vault revenue split |
| Real USDG address on 4663 | `UNDERLYING` | `cast call <addr> "symbol()(string)"` → `USDG`, 6 decimals |
| Real funding stables on 4663 | `STABLES` (comma-separated) | Canonical issuers only — never a token's self-reported metadata |
| Launch seed prices | `SEED_PRICE_H100`, `SEED_PRICE_H200`, `SEED_PRICE_L40S`, `SEED_PRICE_RTX4090` | The oracle pipeline's live snapshot at deploy time (PRICE_SCALE ×10_000: 25_000 = $2.50/GPU-hr) |
| Hypersync token | `ENVIO_API_TOKEN` (infra/.env) | Required by the indexer's config generator for 4663 |

Seed prices are not decoration: the deploy seeds the oracle with them and
initializes every canonical pool at that price, so the first real fills
price against them until the publisher's first publication clears its
deviation trigger. Set them from live collector data, not defaults — the
L40S/RTX-4090 dev defaults are stylized fixtures.

## 1) Fund the deployer

ETH for gas (~2× the testnet footprint — the deploy is ~50 txs) plus the
sgUSD seed gross: ~1.0001 gUSD worth of USDG (Deploy requires the deployer
to hold it — there is no mint on a real reserve). Any bootstrap working
capital (the operator's own first buys) is the deployer's real capital and
moves through the product, not the deploy script.

## 2) Deploy the production core

```sh
cd apps/contracts
UNDERLYING=0x… \
PUBLISHER=0x… \
TREASURY=0x… \
STABLES=0x…,0x… \
SEED_PRICE_H100=25000 SEED_PRICE_H200=32000 SEED_PRICE_L40S=6000 SEED_PRICE_RTX4090=3000 \
PRIVATE_KEY=0x… \
forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --broadcast --sig "run()"
```

What lands, unchanged from every environment: the v4 core (or reused verbatim
via `POOL_MANAGER`/`STATE_VIEW`/`QUOTER` when the chain has a canonical stack
— liquidity must not fragment across two managers) + Permit2 (canonical
address), the hook (mined at the 0x10CC flags), the 4 launch SKUs with
**issuance enabled, oracle seeded at the env prices, canonical pools
initialized live** — empty by design: the hook is the book, genesis buys ride
the in-swap backstop, and LPs provision through the PositionManager. The mint
corridor is 50 bps both ways, the hook fee 50 bps, the POL book ask/bid
0.5%/0.5% + 0.1% POL fee.

### Deployed — 2026-09-13

The production deploy is live on 4663. Robinhood Chain hosts a canonical v4
stack (Robinhood team-deployed); it was reused verbatim via
`POOL_MANAGER`/`STATE_VIEW`/`QUOTER`/`POSITION_MANAGER` (39% less gas than a
fresh stack, and liquidity stays unified on the chain's canonical manager).
Canonical contracts on 4663 (from Robinhood's docs, verified on-chain via
`eth_call` probes — this RPC's `eth_getCode` intermittently returns 0x for
deployed contracts, so never trust a bare `getCode` here):

| Contract | 4663 |
|---|---|
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` |
| V4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |

The deployed record (`deployments/4663.json`) carries `startBlock`
(the pre-broadcast head — the indexer's backfill anchor) and
`oraclePublisher` (the publish identity ops funds and keeps hot).
Seeded from the live collector snapshot: H100 31,855 · H200 40,099 ·
L40S 13,153 · RTX4090 3,946. Broadcast spent ~0.00235 ETH pinned at
0.115 gwei (the chain's base fee sits at ~0.097–0.099 gwei; forge's
default estimate pads 2× and can be pinned with `--with-gas-price`).

There is **no genesis seeding script on mainnet** — deliberately. The
vault's bid capacity is born from the first real genesis buy (the in-swap
backstop's principal becomes bid capacity inside that very swap), and ask
inventory comes from real sells into the bid. Buys work from block one;
sells open once the first real buy has landed. That is the protocol's
self-bootstrapping design, exercised by real money.

## 3) Provisions (the two pools the product expects)

- **Stable funding pool** — the mint desk's USDT/USDG ⇄ gUSD corridor rides
  a hook-free pool at fee 100 / tickSpacing 1 (the `STABLE_POOL` shape in
  `apps/web/src/data/web3/gusd/actions.ts`). Provision it through the
  PositionManager with real capital, full-range, or the stable-funded mint
  path falls back to the reserve route.
- **GPU pools stay LP-less** — that is the launch configuration, not a gap.
  The deterministic mirror prices them from the hook's public state; the
  float-seeded GpuQuoter is only for books that carry native CL liquidity.

## 4) Indexer + oracle + publisher (the stack)

`infra/.env`:

```sh
INDEXER_CHAIN_ID=4663
ENVIO_API_TOKEN=<hypersync token>          # required for 4663
INDEXER_RPC_URL=https://rpc.mainnet.chain.robinhood.com   # fallback reads
PUBLISHER_TARGET=chain
PUBLISHER_RPC_URL=https://rpc.mainnet.chain.robinhood.com
PUBLISHER_CHAIN_ID=4663
PUBLISHER_PRIVATE_KEY=0x…                  # the PUBLISHER key above — publish role only
PUBLISHER_ORACLE_ADDRESS=0x…               # from deployments/4663.json ".oracle"
```

`pnpm stack:up`, then verify: indexer `/ready` green, oracle `/v1/health`
healthy, publisher emitting publications (the first ones confirm the seeds
or replace them on ≥0.5% deviation).

## 5) Web build

```
NEXT_PUBLIC_CHAIN_ID=4663
NEXT_PUBLIC_RPC_URL_4663=https://rpc.mainnet.chain.robinhood.com
NEXT_PUBLIC_ORACLE_URL=<hosted oracle base>
NEXT_PUBLIC_INDEXER_URL=<hosted oracle>/v1/protocol
NEXT_PUBLIC_PRIVY_APP_ID=<app id>
```

Never set on mainnet: `NEXT_PUBLIC_DATA_SOURCE=mock`,
`NEXT_PUBLIC_ENABLE_FUNDING_DEV`, `NEXT_PUBLIC_ENABLE_TX_DEV`. The funding
panel is already capability-gated live for 4663; quotes require Across to
route into Robinhood Chain — until they list it the panel honestly reports
no route, and funding rides the mint desk directly.

## Never on mainnet

- `Deploy.full runFull()` / `Demo` / `IndexerDemo` / `DeployMockOracle` —
  all four now revert on 4663.
- The mock USDT (`0xAd8F…8AFE`) and its per-chain display pins in
  `stables.ts` — Anvil/testnet posture only; 4663 lists only real issuers.
- Public anvil keys (`0xac09…`, `0x5de4…`, `0x7c85…`) signing anything.
- The GpuQuoter's simulation floats — not a mock, but real parked collateral:
  only needed when native LP depth arrives (the mirror handles the launch
  posture without them). If an LP seeds a canonical pool and large quotes
  start failing, fund the lens via `setGusdFloat`/`setGpuFloat` (owner call;
  tokens are never consumed — simulation collateral only).
