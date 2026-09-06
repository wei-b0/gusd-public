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
