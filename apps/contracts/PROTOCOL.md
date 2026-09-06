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
A100_SXM_80GB
H100_SXM_80GB
H200_141GB
B200_192GB
B300_288GB
GB200_192GB
GB300_288GB
```

Human shorthand:

```text
A100
H100
H200
B200
B300
GB200
GB300
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
                         GPU issuance         Uniswap v4
                           reserves               │
                                │                  │
                                ▼                  │
                           GPU tokens ◄────────────┘
```

The capital represented by each branch must be accounted for separately.

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
H100 issuance reserve = 0
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
 ├── 250 gUSD → H100 issuance reserve
 │
 ├── fee → protocol revenue
 │
 └── mint 100 H100 → user
```

This is the primary mechanism through which new GPU-token supply enters circulation.

---

# 7. Meaning of GPU "Backing"

A GPU token is gUSD-backed in the following specific sense:

> New GPU-token supply cannot be created without gUSD capital entering the primary GPU issuance system.

It does **not** mean:

> A GPU-token holder can redeem the token from the protocol for its current oracle value.

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
- GPU reserves,
- treasury,

into synthetic GPU-price counterparties.

---

# 9. Uniswap v4 Secondary Markets

Each supported GPU trades against gUSD through Uniswap v4.

Initial markets:

```text
A100 / gUSD
H100 / gUSD
H200 / gUSD
B200 / gUSD
B300 / gUSD
GB200 / gUSD
GB300 / gUSD
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

They are not GPU underwriters.

They do not guarantee:

- GPU-token NAV,
- GPU-token appreciation,
- token-holder PnL,
- oracle-price redemption.

They retain normal AMM market-making risks.

---

# 16. Native Uniswap Liquidity

V1 should prefer native Uniswap v4 liquidity positions.

For example:

```text
H100
+
gUSD
 ↓
H100/gUSD v4 liquidity
```

Concentrated liquidity determines the token composition required for a position.

There is no protocol requirement that all LPs deposit only gUSD.

A future managed GPU liquidity vault may abstract liquidity provisioning across multiple GPU markets, but it is not required for V1.

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
   H100/gUSD      H200/gUSD      B200/gUSD
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
- primary issuance coordination,
- market safety logic.

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
seller / LP inventory
```

Therefore:

> Every BUY is not automatically a mint.

and:

> Every SELL is not automatically a burn.

Most trading should be ordinary secondary-market activity.

---

# 19. Bootstrapping

The protocol does not need to pre-mint a massive GPU-token inventory.

GPU supply can begin at zero.

Example:

```text
H100 supply = 0
H100 reserve = 0
```

Demand can generate primary issuance.

However, secondary-market liquidity is a separate requirement.

To establish a conventional H100/gUSD LP position, initial liquidity requires some combination of:

```text
H100
+
gUSD
```

The H100 may itself be created through primary issuance.

---

# 20. Capital Separation

The protocol contains several economically distinct pools of capital.

## Reserve Pool

```text
chain reserve asset (USDG / USDC)
 ↓
backs gUSD
```

## GPU Issuance Reserve

```text
gUSD
 ↓
enters when GPU supply is created
```

## LP Capital

```text
GPU + gUSD
 ↓
Uniswap liquidity
```

## sgUSD Capital

```text
gUSD deposits
+
protocol revenue
```

## Treasury

Protocol-owned capital and revenue.

These must not be double-counted.

In particular:

```text
GPU issuance reserve
≠
LP liquidity
```

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
- GPU issuance capital,
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

## Market trading

```text
ordinary secondary trades
must not automatically alter
primary GPU issuance reserve accounting.
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

## Capital

```text
the same capital cannot simultaneously
be treated as GPU issuance reserve
and available LP liquidity.
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
- cross-chain gUSD fungibility / supply portability (each deployment's
  supply is chain-local; the reserve backing on one chain says nothing
  about another),
- protocol-operated bridges (cross-chain funding is a third-party service
  at the UI layer — the protocol never custodies bridged value).

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
  ↓
H100/gUSD Uniswap v4 market
  ↓
H100 buy/sell
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


LPs
=
liquidity providers


Primary Issuance
=
GPU supply creation against gUSD
```

The Solidity implementation should preserve these boundaries.
