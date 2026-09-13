# Uniswap v4 integration map

Judge-facing map of how gUSD integrates Uniswap v4: which contracts, where
they live in this repository, and the exact lines to read. Paths are
repository-relative.

> Note: this public repository omits the off-chain oracle stack
> (`apps/oracle` and its collector packages). Everything Uniswap-facing —
> the hook, the routers, the liquidity vault, issuance, the lens — is here.

## Deployment — Robinhood Chain mainnet (chain ID `4663`)

Start block `61390610`.

| Contract | Address | Source |
| --- | --- | --- |
| **GPUHook** | `0xf60Aa9Cf9720236E51C1D02FF9Cd685FC2b510cC` | `apps/contracts/src/hooks/GPUHook.sol` |
| GpuRouter | `0x9a7348d8Fb6C628889B2e9c2B5BD8fB1FF6F474a` | `apps/contracts/src/GpuRouter.sol` |
| GpuQuoter | `0x9207F55b00b16B6dA00aC977CFB4039f482F9158` | `apps/contracts/src/lens/GpuQuoter.sol` |
| GPUIssuance | `0x7506b03E9A4aD1C6FBBd3E1c355bb76d0462aA6e` | `apps/contracts/src/GPUIssuance.sol` |
| GPUMarketLiquidity | `0xB42045b03a6b5EDBbBA335A01fCb7cA93c2DA4f7` | `apps/contracts/src/GPUMarketLiquidity.sol` |
| gUSD (settlement asset) | `0xAE52d24C85d0261A161B3bE0b444055BD80471F7` | `apps/contracts/src/GUSD.sol` |
| GPUPriceOracle | `0x8CC5b5d1f7334B56e948e12bA7A759F24eA0681c` | `apps/contracts/src/oracle/` |
| StableRouter | `0xc5fe369D2C313B10B2a1971bCA32D3204283dBEc` | `apps/contracts/src/StableRouter.sol` |
| sgUSD | `0x091a94DBc3E90df51364163047E6A81724dCc4a9` | `apps/contracts/src/sgUSD.sol` |
| RevenueLedger | `0x64e3FeE2AB83E0b1E3F6a14eC872e8a7a8253C1a` | `apps/contracts/src/RevenueLedger.sol` |

**Reused canonical v4 infrastructure** (Robinhood Chain's own deployment —
gUSD did not deploy a second PoolManager):

| Contract | Address |
| --- | --- |
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| V4 Quoter | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` |
| StateView | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

## The integration, line by line

### `GPUHook` — the market maker in every canonical GPU/gUSD pool

`apps/contracts/src/hooks/GPUHook.sol`

- **L44** — `contract GPUHook is IHooks, IHookStats, Ownable2Step` — the hook
  contract. Permission mask `0x10CC` (`afterInitialize`, `beforeSwap`,
  `afterSwap`, both swap return-delta flags) is documented at **L32–34** and
  validated via `Hooks.validateHookPermissions` at **L175**; it is encoded in
  the deployed hook address above.
- **L79–89** — immutable v4 wiring: `IPoolManager poolManager`, the gUSD
  currency, issuance, oracle, and the self-deployed `PoolWalk` helper (kept
  address-preserving for CREATE2 mining — see the comment at L85–89).
- **L49–54** — guard constants: spread/fee caps, walk-tick cap, POL notional
  and per-block caps, max oracle staleness (25h default).
- **L190–215** — `afterInitialize`: the canonicality gate. Only the single
  gUSD/GPU pool with the protocol's fee/tickSpacing/hook may exist for a GPU
  id; the hook enforces it at pool creation.
- **L237** — `_oraclePrice`: the guarded oracle read (staleness + range
  checks) performed **inside** every swap.
- **L250–322** — `beforeSwap` (plan phase): derives oracle-anchored edges
  (`edgeSqrt`), simulates the native book's bounded walk to the edge
  (`PoolWalk.walk`, L325 context), clamps to the caller's price limit, and
  returns the beyond-edge absorb/supply as `BeforeSwapDelta`. Stale oracle or
  no beyond-edge work ⇒ zero deltas, pure-native swap.
- **L325–475** — `_plan`: the stateless plan for beyond-edge demand — POL
  ladder then issuance backstop, priced with a 2-wei headroom so the total
  can never exceed the absorbable budget (fails closed).
- **L596–655** — `afterSwap` (realize phase): recovers the absorbed/supplied
  amount from the native `swapDelta`, re-derives spends from a **fresh**
  guarded oracle read, settles both legs to ledger zero. No transient state —
  safe under nested swaps.
- **L657 / 702 / 737 / 796** — the four settle shapes (buy/sell ×
  exactIn/exactOut), including fee routing to the revenue ledger.
- **L855 / 881** — `getReserves` / `polState`: orientation-mapped vault
  inventories and merged-book state for integrators.

### `PoolWalk` — the native book's edge-walk machinery

`apps/contracts/src/libraries/PoolWalk.sol`

- **L27** — `edgeSqrt`: oracle price ± bps edge, composition-divisor aware.
- **L51** — `walk`: simulates `Pool.swap`'s tick traversal against live
  PoolManager state (word-skipped, bounded by `maxWalkTicks`) to find where
  the native book ends and the hook's fills begin.

### `GpuRouter` — the product surface

`apps/contracts/src/GpuRouter.sol`

- **L127** — `buy`: demand a GPU amount, pay at most `maxPaid`; fills through
  the canonical pool (native + POL + issuance backstop).
- **L181** — `buyExactIn`: spend exactly `gusdMaxIn`, receive at least the
  requested GPU.
- **L217** — `sell`: sell GPU for at least `minOut` payout.
- **L256** — `_unlockCallback`: the PoolManager unlock body that executes the
  swap and settles both currencies (Permit2 → PoolManager takes).

### `GpuQuoter` — honest quotes for a hook pool

`apps/contracts/src/lens/GpuQuoter.sol`

- **L24** — the design note: run the **real** pool's **real** hook inside a
  PoolManager lock against float balances.
- **L112 / 118 / 124 / 130** — `quoteBuy`, `quoteSell`, `quoteBuyExactOut`,
  `quoteSellExactOut` (exactIn and exactOut, both sides).

### `GPUMarketLiquidity` — protocol-owned inventory vault

`apps/contracts/src/GPUMarketLiquidity.sol`

- **L13–17** — the custody model: gUSD bid capacity capitalized by issuance
  principal, GPU ask inventory acquired by genuine bid fills. No withdrawal
  path to any EOA; principal exits only as market trades.
- **L82** — `notePrincipal`: issuance principal becomes bid-side market
  capital.
- **L103 / 115** — `pullGpuToManager` / `pullGusdToManager`: the hook pulls
  inventory to the PoolManager **inside the lock**, settled by the hook.
- **L127** — `creditBidFromTrade`: hook-settled buy proceeds re-enter the bid
  inventory.

### `GPUIssuance` — the in-swap backstop

`apps/contracts/src/GPUIssuance.sol`

- **L161** — `issue`: primary issuance at the oracle reference price + fee;
  principal is routed to `GPUMarketLiquidity` as market capital, fee to the
  revenue ledger. Fully decoupled from v4 so a v4 problem can never fail a
  primary buy (comment at L176–181).
- **L202** — `issueCredited`: the hook's in-swap backstop — identical pricing
  and guards, reverts if execution diverges from the plan-time quote (fails
  closed instead of bleeding capital).

## Tests

```sh
cd apps/contracts
forge test
forge snapshot
```

- `test/unit/GPUHook.t.sol` — 24 hook tests (plan/realize, both swap
  directions, both exactness modes, staleness, caps, degradation)
- `test/unit/GpuRouter.t.sol` — 18 router tests; `test/unit/GPUIssuance.t.sol`
  — 28; `test/unit/StableRouter.t.sol` — 18; plus GUSD, sgUSD, oracle,
  RevenueLedger, GPUMarketLiquidity, GpuId suites
- `test/integration/E2E.t.sol` — end-to-end: mint → buy → oracle reprice →
  sell against the live v4 pool; `PositionManagerLp.t.sol` — LP interplay
- `test/invariant/` — bounded-invariant suite over the hook + vault
  (inventory custody, balance ≥ mapped sums)

## Reproduce locally

```sh
pnpm install
cd apps/contracts
forge test          # protocol test suite against a simulated v4 deployment
```

For a live end-to-end run, deploy the full catalogue to a local Anvil chain
(`Deploy.full --sig "runFull()"` — see `apps/contracts/README.md`) and read
the market through the hook. Note: the repo-wide `start-dev.sh` also brings
up the off-chain oracle stack, which this public repository omits.
