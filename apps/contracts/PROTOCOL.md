# gUSD Protocol Specification

## Status

This document describes the canonical economic architecture of the initial gUSD protocol.

It defines **what the protocol is intended to do**.

It intentionally does not prescribe every Solidity contract boundary.

Implementation agents should use this specification to derive an architecture rather than assuming each conceptual component requires a separate contract.

---

# 1. Protocol Thesis

gUSD is a protocol-native monetary layer for an onchain GPU asset economy.

The system consists of:

```text
chain reserve asset (USDG / USDC)
  ↓
gUSD
  ├── sgUSD
  └── GPU assets
        ↓
   Uniswap v4 markets
```

The protocol aims to create liquid, fungible onchain assets representing the economic value of GPU compute while maintaining a common stable settlement asset across the entire GPU economy.

---

# 2. Assets

## gUSD

gUSD is the protocol-native dollar.

gUSD mints 1:1 against **one reserve asset per chain** — the chain's canonical
regulated stablecoin, called the `underlying` throughout this spec and in the
contracts:

| Chain | Reserve asset | Notes |
| --- | --- | --- |
| Robinhood Chain (4663 / 46630) | **USDG** (Global Dollar, Paxos) | the chain's canonical stable; no native USDC/USDT exists there |
| Base, Ethereum, other USDC-canonical chains | **USDC** | Circle's canonical token |
| Anvil (dev) | mock USDC | solmate MockERC20 wearing USDC's identity by Deploy default |

```text
1 unit of the chain's reserve asset
  ↓
1 gUSD
```

and:

```text
1 gUSD
  ↓
1 unit of the chain's reserve asset
```

subject to configured protocol fees.

Beyond the reserve asset, the **StableRouter** accepts additional
owner-whitelisted 6-decimal stables (e.g. USDT where a real one exists): each
is swapped to the reserve asset on Uniswap v4 (caller-supplied pool,
`minOut`-bounded) before the mint, so every funding route lands in the same
reserve. Identity is deployment-config only — the whitelist is set by the
owner, never derived from token symbols (lookalike USDC/USDT scam tokens
exist on every chain).

The implementation uses full reserve backing: `reserveBalance() ==
totalSupply()` at all times, in every funding path.

gUSD is intended to become the common:

- settlement asset,
- quote asset,
- accounting unit,
- GPU issuance asset,
- protocol revenue asset,
- savings-layer underlying.

---

## sgUSD

sgUSD is the savings/revenue-sharing representation of gUSD.

Conceptually:

```text
gUSD
  ↓
stake
  ↓
sgUSD
```

Protocol revenue may increase the amount of gUSD represented by each sgUSD share.

Example:

```text
1,000,000 gUSD
1,000,000 sgUSD

1 sgUSD = 1.00 gUSD
```

After 50,000 gUSD of revenue:

```text
1,050,000 gUSD
1,000,000 sgUSD

1 sgUSD = 1.05 gUSD
```

A non-rebasing share model is preferred.

---

## GPU Tokens

Each GPU token represents the economic value of **one hour of a specific GPU configuration**.

Example:

```text
1 H100
=
1 H100 SXM 80GB GPU-hour
```

The canonical external reference value is provided by the GPU oracle.

If:

```text
H100 oracle price
=
2.50 USD / GPU-hour
```

then:

```text
reference value of 1 H100
≈
2.50 gUSD
```

assuming gUSD is trading at its intended dollar value.

GPU tokens are normal fungible ERC-20 assets.

They may be:

- held,
- transferred,
- traded,
- used as Uniswap liquidity,
- integrated by other protocols.

---

# 3. Initial GPU Catalogue

The initial onchain/tokenized universe is:

```text
H100_SXM_80GB
H200_141GB
L40S_48GB
RTX_4090_24GB
```

Human shorthand:

```text
H100
H200
L40S
RTX 4090
```

Canonical IDs must remain SKU-specific.

For example:

```text
H100
```

means:

```text
H100_SXM_80GB
```

for the initial protocol.

The oracle may support substantially more GPU configurations than are tokenized onchain.

---

# 4. Monetary Architecture

```text
                 chain reserve asset (USDG / USDC)
                                │
                           reserve backing
                                │
                                ▼
                              gUSD
                                │
             ┌──────────────────┼──────────────────┐
             │                  │                  │
             ▼                  ▼                  ▼
           sgUSD         GPU issuance         GPU liquidity
                                │                  │
                                ▼                  ▼
                        market capital        Uniswap v4
                        (POL bid bands)           │
                                │                  │
                                ▼                  │
                           GPU tokens ◄────────────┘
```

Primary principal flows into market liquidity — the two right-hand
branches join in the pool. Capital remains distinguishable by custody
and provenance (§20), not by segregation.

---

# 5. gUSD Reserve

The reserve is a single fully-backed pool of the chain's reserve asset
(USDG on Robinhood Chain, USDC on USDC-canonical chains — see §2).

**Reserve-asset risk.** On Robinhood Chain the reserve is USDG, issued by
Paxos. Paxos operates an on-chain blocklist/freeze capability on its
issuances; a freeze targeting the protocol's reserve wallet or the token
contract could halt mints and — worse — redemptions of gUSD on that chain.
This risk is accepted and monitored: it is the price of using the chain's
canonical regulated stable, and the StableRouter's `pause()` plus GUSD's own
pause are the operational brakes if issuance halts. The same structural
exposure exists on any chain whose reserve asset has an issuer kill switch
(USDC included). gUSD's reserve backing is only as redeemable as the
underlying issuer allows.

Example:

```text
User deposits:
10,000 USDG (or USDC on USDC chains)

Protocol reserve:
+10,000 USDG

User:
+10,000 gUSD
```

The reverse process burns gUSD and releases the reserve asset.

The initial protocol should not depend on:

- lending the reserve asset,
- fractional reserves,
- algorithmic stabilization,
- GPU collateral,
- volatile reserve assets.

Those may only be considered through future explicit protocol design.

---

# 6. Primary GPU Issuance

GPU-token supply begins at zero.

Example genesis:

```text
H100 total supply = 0
H100 market liquidity = 0
```

Suppose:

```text
Oracle H100 price
=
2.50 gUSD
```

A user creates:

```text
100 H100
```

The base capital requirement is:

```text
100 × 2.50
=
250 gUSD
```

Conceptually:

```text
User
 │
 │ 250 gUSD + fee
 ▼
GPU primary issuance
 │
 ├── 250 gUSD → H100 pending market capital
 │              (POL places it as a bid band
 │               below the oracle reference)
 │
 ├── fee → protocol revenue
 │
 └── mint 100 H100 → user
```

The principal does not sit in a reserve. It becomes the corresponding
GPU market's bid-side liquidity, placed by protocol-owned market
liquidity around the oracle reference price.

This is the primary mechanism through which new GPU-token supply enters
circulation — and through which each GPU market's exit depth is funded.

---

# 7. Meaning of GPU "Backing"

A GPU token is gUSD-backed in the following specific sense:

> New GPU-token supply cannot be created without gUSD capital entering the
> primary GPU issuance system — and that capital becomes the corresponding
> market's bid-side liquidity.

It does **not** mean:

> A GPU-token holder can redeem the token from the protocol for its current oracle value.

Backing is a flow constraint on supply, not a vault claim. Once principal
converts to GPU through legitimate trades, no equation ties it back to the
tokens outstanding.

This distinction is fundamental.

---

# 8. No Oracle-NAV Redemption

Suppose:

```text
H100 issued at:
2.50 gUSD
```

Later:

```text
Oracle H100:
3.00 gUSD
```

The holder does not have a protocol claim for:

```text
3.00 gUSD
```

The protocol does not pay the holder's gain.

The holder realizes the new value by selling H100 through the secondary market.

This avoids turning:

- LPs,
- protocol-owned market liquidity,
- treasury,

into synthetic GPU-price counterparties.

---

# 9. Uniswap v4 Secondary Markets

Each supported GPU trades against gUSD through Uniswap v4.

Initial markets:

```text
H100 / gUSD
H200 / gUSD
L40S / gUSD
RTX 4090 / gUSD
```

Example purchase:

```text
Alice
 │
 │ gUSD
 ▼
H100 / gUSD
Uniswap v4
 │
 │ H100
 ▼
Alice
```

Example sale:

```text
Alice
 │
 │ H100
 ▼
H100 / gUSD
Uniswap v4
 │
 │ gUSD
 ▼
Alice
```

A GPU holder's ordinary exit mechanism is therefore a **market sale**, not protocol redemption.

---

# 10. Market Gains and Losses

Suppose:

```text
Alice buys H100:
2.50 gUSD

Later market price:
3.00 gUSD
```

Alice may sell H100 into the market for approximately the new market value.

The additional value comes from the buyer / available market liquidity.

It is not paid directly by the protocol.

This is intended to resemble a normal spot asset market.

---

# 11. GPU Oracle

The GPU oracle provides the canonical external reference value for one GPU-hour.

It is built independently from the protocol contracts.

Conceptually:

```text
GPU rental markets
       ↓
offchain indexer
       ↓
normalized GPU index
       ↓
oracle publication
       ↓
onchain GPU price
```

Current intended policy:

```text
index evaluation       ~15 seconds
deviation publication  0.5% / 50 bps
heartbeat              approximately 24 hours
```

The precise production implementation is outside the contracts workspace.

Contracts should depend only on a minimal oracle interface.

Implementation note (2026-09): the publication path is live — the offchain
publisher writes `GPUPriceOracle.publish()` (publisher-EOA signed; owner
`setPriceOverride` is genesis/incident-only). The optional onchain deviation
bound is a compromised-key safety valve, distinct from the 0.5% publication
trigger above, and ships disabled by default. No economics change.

---

# 12. Oracle Price vs Market Price

The oracle and Uniswap serve different purposes.

Oracle:

```text
What is one H100 GPU-hour worth
in the underlying compute economy?
```

Uniswap:

```text
At what price can the H100 token
be bought or sold onchain right now?
```

Therefore:

```text
Oracle:  2.500 gUSD
Market:  2.507 gUSD
```

is acceptable.

The protocol does not require every swap to execute exactly at oracle price.

---

# 13. Primary Issuance as Supply Elasticity

Primary issuance provides a mechanism that can increase GPU-token supply when secondary-market demand pushes the token materially above its reference value.

Example:

```text
Oracle H100:
2.50

Market H100:
2.65
```

If primary issuance is available near:

```text
2.50 + issuance fee
```

a participant can:

```text
gUSD
 ↓
mint H100
 ↓
sell H100 into market
```

This:

```text
increases GPU supply
       ↓
adds sell-side liquidity
       ↓
pushes market toward reference value
```

The arb seller's exit is the POL bid band — depth funded by the
principal of prior primary demand. The same flow that creates the
arbitrage opportunity funds its execution.

The exact rules controlling issuance availability remain to be finalized.

---

# 14. Below-Oracle Markets

Suppose:

```text
Oracle H100:
2.50

Market H100:
2.35
```

The holder does not gain a guaranteed right to redeem for 2.50 gUSD.

In V1 the downside absorber is the POL bid band: sells fill into depth
funded by historical primary demand, priced at the band's spread below
the reference. That depth is finite — when it is exhausted, sell depth
is honestly zero. It is a market, not a floor.

Potential future mechanisms may include protocol market operations such as:

```text
market buy
   ↓
acquire H100
   ↓
burn H100
   ↓
reduce supply
```

but no such operation should be interpreted as a guaranteed redemption promise.

The exact downside supply-management mechanism is not required for the initial implementation.

---

# 15. Liquidity Providers

LPs provide liquidity to Uniswap v4 GPU/gUSD markets.

Their role is:

```text
provide liquidity
       ↓
facilitate buys and sells
       ↓
earn fees
```

Third-party LPs are optional in V1: the protocol makes its own markets
through POL bands funded by primary principal (§16).

They are not GPU underwriters.

They do not guarantee:

- GPU-token NAV,
- GPU-token appreciation,
- token-holder PnL,
- oracle-price redemption.

They retain normal AMM market-making risks.

---

# 16. Native Uniswap Liquidity

V1's native liquidity is protocol-owned market liquidity (POL): the
principal from primary issuance, placed as oracle-anchored bands on the
canonical v4 pools.

For example:

```text
primary H100 demand (gUSD)
 ↓
POL bid band below the oracle reference
 ↓
H100/gUSD v4 liquidity
```

A one-sided concentrated position holds a single token, so bid bands
require zero GPU: principal is never paired against a matching deposit.
As price crosses a band, the market itself converts it — bid gUSD
becomes GPU inventory, ask GPU becomes gUSD.

Third-party LPs may add to the same pools, but there is no protocol
requirement for them and no 50/50 pairing subsidy. A future managed GPU
liquidity vault may abstract provisioning further, but it is not
required for V1.

---

# 17. GPUHook

The protocol uses a custom Uniswap v4 hook.

One hook implementation may serve multiple canonical GPU/gUSD pools.

Conceptually:

```text
                   GPUHook
                      │
       ┌──────────────┼──────────────┐
       ▼              ▼              ▼
   H100/gUSD      H200/gUSD      L40S/gUSD
       │              │              │
       └──── other GPU/gUSD pools ───┘
```

Possible responsibilities include:

- pool validation,
- GPU identification,
- oracle integration,
- oracle freshness enforcement,
- oracle/market deviation monitoring,
- protocol fee collection,
- dynamic fee behavior,
- market safety logic.

Primary issuance is not among them: it is fully decoupled from pool
execution (§6), so a pool-side failure can never block minting.

The hook should use native v4 behavior wherever possible.

The hook should not recreate an AMM without a concrete requirement.

---

# 18. Primary Issuance vs Secondary Trading

These are distinct operations.

## Primary issuance

Creates new supply:

```text
gUSD
 ↓
GPU issuance
 ↓
new GPU token
```

## Secondary trading

Transfers existing supply:

```text
buyer
  ↕
Uniswap v4
  ↕
seller / LP / POL inventory
```

Therefore:

> Every BUY is not automatically a mint.

and:

> Every SELL is not automatically a burn.

Most trading should be ordinary secondary-market activity.

---

# 19. Bootstrapping

The protocol does not need to pre-mint a massive GPU-token inventory,
and it does not pre-seed GPU pools with paired liquidity.

GPU supply can begin at zero.

Example:

```text
H100 supply = 0
H100 market liquidity = 0
```

Demand generates primary issuance; each issuance's principal lands as
pending market capital. A permissionless placement (`deployPending`)
puts it on the canonical pool as a bid band around the oracle
reference — the router attempts it on every buy, so normal latency is
one block. A separate permissionless `recenter` re-anchors stale bands
when the reference moves: inventory is removed and redeployed around
the current oracle, gUSD to the bid side, GPU to the ask side.

Sellers thus always face depth funded by the demand that preceded
them. Before the first issuance, sell depth is honestly zero.

---

# 20. Capital Separation

The protocol contains several economically distinct pools of capital.

## Reserve Pool

```text
chain reserve asset (USDG / USDC)
 ↓
backs gUSD
```

## Market Capital (POL)

```text
gUSD
 ↓
enters when GPU supply is created
 ↓
bid-side liquidity on the canonical pool
```

## LP Capital

```text
GPU + gUSD
 ↓
Uniswap liquidity (third-party)
```

## sgUSD Capital

```text
gUSD deposits
+
protocol revenue
```

## Treasury

Protocol-owned capital and revenue.

The reserve pool and sgUSD capital must not be double-counted.

Market capital is the deliberate exception to separation: primary
principal merges into pool liquidity on purpose — that is the design.
What is invariant is custody and provenance, not segregation. Principal
can only become: gUSD held by POL, gUSD inside POL positions, or GPU
acquired through those positions and fee accrual. Fees are separately
identifiable and are the only portion that becomes protocol revenue.
There is no withdrawal path at all.

---

# 21. Revenue

The protocol should charge economically reasonable fees where appropriate.

Potential revenue sources include:

```text
gUSD mint/redeem fees
GPU primary issuance fees
GPU market hook fees
future GPU financial products
other protocol services
```

Revenue may be distributed among:

```text
sgUSD
protocol treasury
other future incentive destinations
```

The final percentages are not yet fixed.

---

# 22. Protocol Flywheel

The intended economic loop is:

```text
reserve-asset funding enters (USDG / USDC / whitelisted stables
via the StableRouter)
    ↓
gUSD grows
    ↓
GPU demand grows
    ↓
primary GPU issuance grows
    ↓
gUSD committed to GPU issuance grows
    ↓
GPU liquidity and trading grow
    ↓
protocol revenue grows
    ↓
sgUSD becomes more valuable/useful
    ↓
gUSD ecosystem grows
```

The GPU economy therefore creates structural demand for gUSD.

---

# 23. Why gUSD Exists

The GPU protocol could technically use the reserve asset directly.

gUSD exists because the ambition is broader than:

```text
GPU_TOKEN / USDG (or USDC) trading
```

gUSD becomes:

- protocol money,
- common GPU settlement currency,
- savings-layer underlying,
- GPU issuance capital (→ market capital),
- fee accounting asset,
- future financial primitive.

This creates a coherent monetary system around GPU assets rather than merely a collection of token pairs.

---

# 24. UX

Users do not necessarily need to manually interact with gUSD.

For example, the frontend may expose:

```text
BUY H100
Pay with gUSD
```

while internally routing through the secondary market.

## Stable routing

The mint desk offers every funding stable the deployment whitelists:

```text
MINT gUSD
Fund with: [USDG] [USDT] [USDC …]
```

The chain's reserve asset is the home asset and mints directly through
GUSD; any other whitelisted stable routes through the StableRouter, which
swaps it to the reserve asset on Uniswap v4 before minting — the user sees
one quote with one floor, the reserve asset never becomes a second product
token, and redemption can pay out in any whitelisted stable the same way.

Stable identity is never read from token metadata (`symbol()`/`name()`):
lookalike USDC/USDT scam tokens exist on every chain. The frontend names
assets from two hand-written sources only — the deployment record and its
own per-chain display config — cross-checked against each other and failed
loudly on mismatch.

## Cross-chain funding

Users on other chains fund the active chain through third-party bridging
aggregators (Across today) at the UI layer. The policy:

- **the protocol never bridges and never custodies bridged value** — the
  bridge is a third-party service whose quotes and fills live entirely
  outside the protocol's action runner;
- the bridge's guaranteed minimum output is what the mint hand-off prefills,
  so the user's floor is explicit;
- a post-deposit bridge failure is surfaced honestly (the deposit still
  fills — the user is told not to re-bridge);
- **supply is chain-local**: gUSD minted on one chain exists only on that
  chain. Cross-chain funding moves the *reserve asset* into the wallet; it
  never makes gUSD itself portable.

---

# 25. Protocol Invariants

## gUSD

```text
gUSD cannot be created without eligible reserve backing.
```

For V1, on every chain and every funding path (direct reserve mints and
StableRouter swap mints alike):

```text
1 gUSD ↔ 1 unit of the chain's reserve asset
```

---

## GPU issuance

```text
GPU-token supply cannot increase
without corresponding gUSD entering
the primary issuance system.
```

---

## POL flow conservation

```text
every gUSD entering primary issuance
is fully accounted: principal → market
liquidity, fee → protocol revenue.
The issuance contract holds zero gUSD at rest.
```

---

## POL provenance

```text
protocol-owned market liquidity never mints GPU.
Every GPU it holds originates from market swaps
(band conversions) or LP fee accrual —
never from paired minting.
```

---

## Custody

```text
principal can only become: gUSD held by POL,
gUSD inside POL positions, or GPU acquired
through those positions and fee accrual.
Fees are separately identifiable and are the
only portion that becomes protocol revenue.
There is no withdrawal path.
```

---

## Oracle-fresh placement

```text
nothing is ever placed at a stale reference.
Placement, recentring, and issuance itself all
revert on a stale oracle.
```

---

## Exhaustion honesty

```text
bid depth is funded only by historical primary demand.
When a GPU market's bid bands are gone,
sell depth is genuinely zero —
no synthetic seller backstop exists.
```

---

## Market trading

```text
ordinary secondary trades move inventory
between the bid and ask sides.
They never mint GPU or create principal.
```

---

## LPs

```text
LP principal is not the solvency backstop
for GPU-token appreciation.
```

---

## Redemption

```text
GPU token ownership does not imply
oracle-NAV redemption from the protocol.
```

---

## Price

```text
oracle price
and
market price
are distinct values.
```

---

## Cumulative principal is a statistic

```text
principal contributed is cumulative accounting,
never a claim on present assets.
Once gUSD has converted to GPU through trades,
no unit-preserving gUSD equation remains.
Depth is displayed from live pool state only.
```

---

# 26. Explicit Non-Goals

The initial protocol does not require:

- GPU-collateralized gUSD borrowing,
- CDPs,
- GPU liquidations,
- GPU-token oracle-NAV redemption,
- LP underwriting of GPU appreciation,
- perpetuals,
- user short positions,
- lending markets,
- custom AMM curves,
- reserve yield deployment,
- algorithmic gUSD stabilization,
- automated GPU buyback systems,
- automated multi-GPU LP vaults,
- oracle-bounded swap filtering (the pool accepts market prices; stale
  bands are recentred rather than blocking swaps at stale prices —
  blocked swaps would be dead capital),
- cross-chain gUSD fungibility / supply portability (each deployment's
  supply is chain-local; the reserve backing on one chain says nothing
  about another),
- protocol-operated bridges (cross-chain funding is a third-party service
  at the UI layer — the protocol never custodies bridged value).

Band recentring IS in scope (it is the mechanism that keeps POL honest
around a moving reference). Contract-upgrade migration is not: the
protocol ships as an immutable V1.

These may become future products but are not foundational requirements.

---

# 27. Initial End-to-End Target

The first complete protocol flow should demonstrate:

```text
chain reserve asset (USDG / USDC)
  ↓
gUSD
  ↓
primary H100 issuance
  ↓
H100 in user's wallet
  + principal → H100 bid band (POL)
  ↓
H100/gUSD Uniswap v4 market
  ↓
H100 buy/sell (sells fill into the bid band)
  ↓
LP fees
  ↓
protocol revenue
  ↓
sgUSD revenue accrual
```

with no GPU-NAV redemption obligation and no LP underwriting liability.

---

# 28. Core Mental Model

```text
USDC
=
reserve asset


gUSD
=
money


sgUSD
=
savings


GPU tokens
=
GPU-hour assets


GPU Oracle
=
external reference price


Uniswap v4
=
marketplace


GPUHook
=
GPU-specific market logic


POL (GPUMarketLiquidity)
=
primary principal making markets
around the oracle


LPs
=
optional additional liquidity providers


Primary Issuance
=
GPU supply creation against gUSD
```

The Solidity implementation should preserve these boundaries.
