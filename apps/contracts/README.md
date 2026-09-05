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
| `UNDERLYING` | Existing USDC-like underlying (default: deploys a mock) |

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
