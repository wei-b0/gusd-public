## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.

## Documentation

https://book.getfoundry.sh/

## Usage

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy

```shell
$ forge script script/Deploy.s.sol --rpc-url <your_rpc_url> --broadcast --slow
```

Deploy variables (env; see `script/Deploy.s.sol`):

| Variable | Meaning |
|---|---|
| `PRIVATE_KEY` | Deployer key (required) |
| `ORACLE` | Wire an external `IGPUPriceOracle` verbatim; unset deploys `GPUPriceOracle` |
| `PUBLISHER` | Publisher EOA for the deployed oracle (default: deployer) |
| `ORACLE_MAX_DEVIATION_BPS` | Onchain per-publish deviation bound, 0 = disabled (default) |
| `TREASURY` | RevenueLedger treasury (default: deployer) |
| `UNDERLYING` | Existing reserve-asset token (gUSD's `underlying`; default: deploys a mock) |
| `UNDERLYING_NAME` / `UNDERLYING_SYMBOL` | Identity the mock wears (defaults "Global Dollar"/"USDG" — the Robinhood Chain posture; set "USD Coin"/"USDC" where USDC is canonical) |
| `STABLES` | Comma-separated extra StableRouter-whitelisted stables (the underlying is whitelisted at construction) |
| `POOL_MANAGER` / `STATE_VIEW` / `QUOTER` / `POSITION_MANAGER` / `WETH` | Reuse an existing canonical Uniswap v4 stack instead of deploying one (e.g. Robinhood Chain mainnet's) |

The deployed oracle is genesis-seeded at \$2.50/GPU-hour for `H100_SXM_80GB`
via the owner hatch; `deployments/<chainId>.json` records `oraclePublisher`
when we deployed the oracle (an external `ORACLE` is never seeded and omits
that key — prices arrive through its own publication path). The canonical
GPU/gUSD pool initializes at the oracle's LIVE price for the registered GPU
(derived via `GPUIssuance.oracleSqrtPriceX96`, not a hardcoded tick), so an
external `ORACLE` that has never published fails the deploy with
`OraclePriceZero` — publish a price first (dev utility:
`forge script script/DeployMockOracle.s.sol`, then `cast send` `setPrice`
before running `Deploy`).

### sgUSD seed and external underlyings

The deploy seeds sgUSD with one unit of the reserve asset. With a mock
underlying the script mints it. With a real external `UNDERLYING` the
deployer's EOA must already hold ≥ 1 unit (1e6 raw — 6-decimal stables) and
the script funds the seed via approve + mint. Deploy with an unfunded EOA
and the seed step reverts.

### Robinhood Chain testnet recipe (chainId 46630)

Arbitrum Orbit L2 where **USDG is the canonical stable** — no real USDC or
USDT exists on-chain (explorer matches are 18-decimal lookalike scams), so
the reserve asset is USDG.

1. **USDG address first.** Resolve the canonical USDG on the network
   (Paxos docs / the official OFT wrapper), verify `decimals() == 6` and
   standard ERC20 selectors through the diamond facets with `cast` — never
   trust a symbol. If testnet USDG cannot be verified, deploy a stand-in
   token and leave `UNDERLYING_NAME=Global Dollar`,
   `UNDERLYING_SYMBOL=USDG` so the mock wears the right identity.
2. **Deploy:**

   ```shell
   PRIVATE_KEY=0x… \
   UNDERLYING=0x…(verified USDG, or omit for the stand-in) \
   UNDERLYING_NAME="Global Dollar" UNDERLYING_SYMBOL=USDG \
   STABLES=0x…(any real extra stables — usually none today) \
   forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.chain.robinhood.com --broadcast
   ```

   Permit2 is detected and reused when present on the chain. No stable pool
   is created by the deploy — LPs provision StableRouter pools via the
   PositionManager; until then the router serves the identity path only.
3. **Commit** `deployments/46630.json` and run
   `pnpm --filter @gusd/web abi:sync` from the repo root — the web app
   reads addresses from the generated record, keyed to
   `NEXT_PUBLIC_CHAIN_ID=46630` with `NEXT_PUBLIC_RPC_URL_46630`.
4. **Verify on the explorer:** mint a round trip (`cast call` previews
   against `cast send` results), confirm the StableRouter identity mint,
   then walk mint/redeem in the web app.

The swap path (USDT→USDG style routing) cannot be exercised on testnet
until a funded USDG/stable pool exists; the Across funding panel degrades
to guidance on 46630 by registry capability — Across serves mainnets only.

### Full-catalogue dev/testnet deploy

`Deploy.s.sol` is the production posture: every contract, but only H100
registered, no pool liquidity, and the reserve as the sole stable. That is
enough for the test suite, not for exercising the app end to end.
`script/Deploy.full.s.sol` layers the full dev/test posture on top of an
unchanged production deploy:

```shell
$ anvil
$ PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  forge script script/Deploy.full.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --sig "runFull()"
```

Works on Anvil or any testnet with a funded deployer key (same env
passthrough as `Deploy`: `ORACLE`, `PUBLISHER`, `TREASURY`, `UNDERLYING`, …
— the inner production deploy reads them). What it adds beyond
`Deploy.run()`:

- **All 7 SKUs** (A100/H100/H200/B200/B300/GB200/GB300) created, oracle-seeded
  (\$1.80–\$10.00/GPU-hour), issuance enabled, canonical pool initialized from
  the seed price.
- **Genesis inventory via the real issuance→POL path**: 10,000 GPU per SKU
  issued to the deployer through 100%-issuance buys paid in gUSD — each
  buy's principal capitalizes that market's POL bid band (there is no
  treasury LP bootstrap on GPU pools; the only PositionManager position is
  the stable pool below).
- **A mock second stable** (`Mock Tether USD`, 6 decimals) deployed through
  the CREATE2 proxy with the fixed salt `gusd.mock.usdt.v1` — the address is
  deterministic per chain (Anvil: `0xAd8F7921738819152FFA371c984D736842ed8AFE`)
  — whitelisted on the StableRouter, and paired with the reserve in a
  hook-free fee-100/tickSpacing-1 pool at 1:1, exactly the key the web's
  funding panel quotes.
- **Stable-pool seed** via PositionManager (Permit2 double-approvals):
  ~10M units per side at 1:1. GPU pools start with POL bands only —
  bid-side depth from primary principal, ask-side inventory converted
  from it by trading.
- **Bootstrap-conversion pass**: the deployer sells 100 GPU per SKU into
  the fresh bid band, converting ~1% of each band into ask-side inventory
  so pool buy legs are quotable immediately.
- **Compact activity pass** (anvil keys #2/#3): buys, sells, a USDT→gUSD
  mint plus redeem, an oracle reprice with an issuance-only buy (whose
  principal honestly DEFERS while its pool still trades at the old
  price), fee harvest, revenue distribution, and a stake — so the tape,
  ledgers, cost basis, and sgUSD accrual are populated immediately.
- **Convergence pass** (H100, after the reprice): a permissionless
  `recenter` removes the stale $2.50-anchored bands and redeploys the
  same real inventory around $3.00 (GPU → ask band now; the recovered
  gUSD honestly defers — the pool is still cheaper than the whole new
  bid zone), then an arbitrage buy lifts the pool spot from ~$2.50 into
  the fresh ask band (~$3.02, the force the design waits for), and the
  deferred principal — bob's 3 gUSD plus the recentred band — places as
  the new bid band at the oracle anchor. The desk ends the run showing
  market ≈ oracle ≈ index (spot within 720 ticks of the reference,
  asserted) instead of a 17% discount.
- **End asserts**: every SKU's `principalContributed` equals its seeded
  demand, `pendingPrincipal == 0` everywhere (H100's via the
  convergence pass), `bidDepth > 0` per SKU, router/hook dust drained,
  both stables whitelisted, stable-pool 1:1 within tolerance, sgUSD
  accreting. The record is re-persisted with `stables = [reserve,
  USDT]` and a `startBlock` captured before any of the run's
  transactions (the indexer's backfill anchor).

After deploying, run `pnpm --filter @gusd/web abi:sync` and pin the mock
USDT in `apps/web/src/data/web3/stables.ts` (already pinned for
31337/84532/46630 — the deterministic address means redeploys need nothing).

Division of labor: **`Deploy` + `Demo`** replays the minimal H100 flow on a
*virgin* Anvil and stays the CI/contract-test recipe. **`Deploy.full`** is
the everything posture for web E2E on Anvil or testnet — its result is not
virgin, so `Demo` will not run after it. Two corollaries:

- Run plain `Deploy` (no `Demo`) and the funding panel intentionally fails
  closed: `stables.ts` pins the mock USDT the minimal record's StableRouter
  does not whitelist. Re-run `Deploy.full` (or remove the pin deliberately)
  to restore the multi-stable surface.
- The web anvil suite's trading tests (`trading.anvil.test.ts`) assert the
  *genesis* posture — an empty canonical pool, buys = 100% issuance, and
  sells quoting against the bid band that the same buy's principal just
  capitalized (proceeds ≤ the issuance price). They hold only against a
  plain `Deploy` chain; after `Deploy.full` the pool has third-party-scale
  depth and trades no longer price 100% through issuance.
- The indexer derives canonical GPU pools on-chain at boot, so start it
  fresh after this deploy. An indexer already running against the same
  chain/schema misses pools created after it started — follow the
  fresh-schema redeploy in `docs/indexer/ARCHITECTURE.md`.

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```
