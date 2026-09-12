# gUSD Web Product

## Overview

gUSD is a protocol for creating onchain financial markets around GPU compute prices.

The product allows users to gain financial exposure to the economics of GPU compute without purchasing, renting, operating, or consuming the underlying compute.

gUSD does not provide GPU infrastructure and is not a compute marketplace.

It does not:

- rent GPUs
- sell GPU-hours
- provision compute
- execute AI workloads
- broker workloads to GPU providers
- operate as a cloud provider

The underlying GPU rental market is used as a source of economic price information.

gUSD builds financial products and markets around that information.

---

# Product Model

The gUSD product consists of several closely related layers:

- GPU Assets
- Markets
- gUSD
- sGUSD
- Earn
- Index
- Data
- Protocol
- Terminal
- Portfolio
- Vaults / capital products

These should feel like parts of one coherent financial system rather than separate products.

---

# GPU Assets

gUSD creates financial assets associated with specific GPU classes.

The initial GPU catalogue is:

- H100
- H200
- L40S
- RTX 4090

Within the product, individual assets should normally be referred to simply by their GPU name:

- H100
- H200
- L40S
- etc.

Collectively, they are referred to as **GPU assets**.

The primary product experience should not unnecessarily emphasize that these are crypto tokens.

Users should think in terms of positions and markets.

Examples:

- H100 position
- H200 market
- L40S price
- RTX 4090 exposure

rather than repeatedly seeing terminology such as:

- H100 token
- H200 token
- GPU token

---

# GPU Asset Markets

Each GPU asset can trade against gUSD.

Initial markets conceptually include:

```text
H100 / gUSD
H200 / gUSD
L40S / gUSD
RTX 4090 / gUSD
```

These are financial markets.

They are not marketplaces for purchasing actual compute.

A GPU asset has a market price determined by market activity.

That market price is distinct from the reference price of the underlying GPU compute market.

---

# gUSD

gUSD is the common quote and settlement asset across GPU asset markets.

Conceptually:

```text
H100 ──────┐
H200 ──────┤
L40S ──────┼──── gUSD
RTX 4090 ──┘
```

This gives GPU markets a shared monetary layer rather than creating a collection of unrelated trading pairs.

Within the application, gUSD represents liquid capital that can be:

- used to acquire GPU assets
- received when GPU assets are sold
- deployed into earning products
- used in protocol liquidity/capital products where applicable

The exact monetary, issuance, backing, and accounting mechanics of gUSD belong to the protocol specification and should not be invented by the web application.

---

# sGUSD

sGUSD is the earning layer associated with gUSD capital.

The conceptual user model is:

```text
GPU assets → market exposure

gUSD       → liquid capital

sGUSD      → earning capital
```

A familiar financial analogy is:

```text
GPU assets     → investment positions

gUSD           → cash balance

sGUSD          → earning / savings balance
```

sGUSD should not be treated as another GPU asset.

Its role is different.

The user-facing product around sGUSD should primarily focus on the action of earning rather than requiring users to understand the token primitive first.

The exact sources of sGUSD yield and protocol revenue routing are still subject to protocol design.

The web application must not invent or imply finalized yield mechanics that do not yet exist.

---

# Earn

Earn is the consumer-facing surface for deploying gUSD into sGUSD or related earning mechanisms.

The experience should eventually allow users to understand:

- available gUSD
- current earning balance
- sGUSD balance/value
- representative APY or return information
- deposit
- withdraw
- source and composition of yield where available

During the product-shell phase, these interactions may be prototyped with mock data.

Any APY, revenue source, or performance values must be treated as prototype data unless backed by the real protocol.

---

# Vaults

The product may include a broader Vaults or capital-products layer.

Vaults may eventually represent different ways of deploying capital across the protocol.

The exact catalogue and mechanics are not finalized.

The frontend should therefore avoid tightly coupling the product architecture to one fixed vault model.

For the shell phase, Vaults can be represented as a discoverable capital-product interface with prototype deposit/withdraw flows.

---

# Index

The gUSD Index provides reference benchmarks for underlying GPU compute prices.

This is a critical distinction:

```text
Index price != GPU asset market price
```

For example:

```text
H100 Market   $2.51

H100 Index    $2.43 / GPU-hour

Basis         +3.29%
```

The **Index** represents a normalized reference value derived from the underlying GPU compute rental market.

The **Market price** represents the price at which the financial GPU asset is currently trading.

The difference between these values may be represented as:

- basis
- premium
- discount

This distinction should remain clear throughout the application.

---

# Index Product

The Index should be useful independently of trading.

A user may visit gUSD purely to understand current GPU pricing.

An Index surface may eventually expose:

- current reference price
- historical reference prices
- provider observations
- observed price range
- data freshness
- provider coverage
- methodology
- weighting
- normalization
- confidence
- historical charts

The Index should be useful to:

- AI companies
- GPU infrastructure operators
- researchers
- traders
- funds
- analysts

even if they never connect a wallet.

---

# Underlying GPU Pricing Data

The Index is informed by observations from the GPU rental ecosystem.

Conceptually, the data pipeline is:

```text
GPU providers / pricing sources
            ↓
         ingestion
            ↓
       normalization
            ↓
      GPU pricing data
            ↓
           Index
```

The exact provider list, weighting, filtering, normalization methodology, and oracle implementation are separate engineering decisions.

The web application should consume these through stable data interfaces rather than implementing the logic itself — and does: the oracle's published candidates (REST + SSE) are the web app's default Index source as of 2026-09-05 (see the Data section).

---

# Data

gUSD Data is the programmatic and analytical interface to GPU pricing and financial-market information.

It is distinct from Index.

The distinction is:

```text
Index → benchmark

Data  → information
```

The Data product may eventually expose:

- raw provider observations
- normalized provider prices
- historical GPU rental prices
- Index history
- market prices
- volume
- liquidity
- basis
- market statistics
- provider metadata

Possible interfaces may eventually include:

- REST APIs
- streaming APIs
- WebSockets
- downloadable datasets
- historical-data products

**Shipped (2026-09-05):** the oracle's real interfaces exist and the web app consumes them directly — `GET /v1/prices`, `/v1/prices/:gpu`, `/v1/prices/:gpu/history`, `GET /v1/prices/:gpu/candles` (server-bucketed OHLC over the canonical benchmark time series stored in `index_candidates` — open/high/low/close derived from the benchmark observations within each interval, 1m/5m/15m/30m/1h/6h/12h/1d/1w grains, bucket-capped), `/v1/prices/:gpu/providers`, `/v1/providers`, `/v1/health` (all read-only REST, CORS open), an SSE stream at `/v1/stream/sse` carrying each published candidate (WebSocket variant at `/v1/stream`), and the web app's Oracle **Developers tab documents this surface in-app** — the interface catalog, endpoint reference, and code samples are product surfaces, not external docs. Every settlement panel in the catalog (H100/H200/L40S/RTX 4090) is oracle-backed, and the API/data layer is the **single source of truth** for every displayed price: the benchmark it publishes is the one price the market and trading surfaces show — where no venue prices the asset separately the second-price slots do not exist on the surface. Market-layer facts the API does not publish (venue price, trades, volume, liquidity) render as honest empties (`—`, an empty tape) rather than simulated figures. Candles for every chart range, sparklines (the series' last 48 hourly closes), and window statistics derive from the server-bucketed benchmark series; live candidates merge into the trailing bucket as they arrive. Before real swaps exist, candles come from the benchmark series — not fake trades and not oracle publications; once Uniswap v4 pools have indexed swaps, an actual trade-OHLCV market series can be added alongside. On-chain reads stay out of display paths — the chain is touched only where execution, balances, and allowances require it; the onchain `GPUPriceOracle` is a protocol execution primitive (hooks, swaps, issuance, redemption), never the frontend's displayed price. `NEXT_PUBLIC_DATA_SOURCE=mock` restores the fully simulated layer (its one admission lives on the status line).

The exact API design is not yet finalized.

The web product should provide a designed Data surface without inventing production endpoints.

---

# Markets

Markets is the main discovery surface for GPU assets.

Users should be able to compare GPU markets using information such as:

- market price
- 24h movement
- longer-term movement
- Index/reference price
- basis
- volume
- liquidity
- market activity
- historical charts

The Markets experience should make the GPU asset class understandable as a whole.

---

# GPU Asset Detail

Every GPU asset has one detailed surface: its desk on the Terminal. There is no
separate market detail page — Markets is the discovery board, and clicking an
asset anywhere in the product opens `/terminal/[asset]`, where analysis and
execution live under one roof.

For example, the H100 desk exposes:

- current H100 market price
- price change
- historical market chart
- gUSD H100 Index
- current basis
- volume
- liquidity
- market statistics
- recent market activity
- Buy
- Sell

The relationship between these three concepts should be clear:

```text
Underlying GPU rental market
            ↓
        gUSD Index
            ↓
      GPU asset market
```

The underlying market informs the benchmark.

The GPU asset itself trades on gUSD.

---

# Terminal

Terminal is the professional trading interface — and the one place users trade.
Every asset's depth (chart, statistics, the Index feed, activity) and its
order entry live here together; Markets is discovery only. Provider/reference
observations live on the Oracle's Benchmarks tab, which the desk's Index feed
links to.

The Terminal ships the full interaction model today:

- GPU asset selector
- price chart
- market statistics
- Index
- basis
- liquidity information
- order entry
- Buy/Sell
- portfolio context
- recent trades
- activity
- positions

The shell implementation prototypes the complete interaction model without pretending that mock trades are real onchain transactions.

The Terminal may be deliberately more information-dense on desktop than the rest of the application.

---

# Portfolio

Portfolio provides a unified view of a user's gUSD activity and holdings.

Conceptually it may include:

- total portfolio value
- GPU asset positions
- gUSD balance
- sGUSD balance/value
- vault positions
- liquidity positions
- unrealized performance
- recent activity
- transactions

The portfolio model should reinforce:

```text
GPU assets → positions

gUSD       → available capital

sGUSD      → earning capital
```

---

# Protocol

Protocol is the technical/onchain layer behind the product.

The product architecture currently assumes that GPU asset markets are built using:

- Uniswap v4 pools
- custom gUSD Uniswap v4 hooks
- gUSD as the common quote/settlement asset

The system should not be redesigned by the web application as:

- a standalone custom AMM
- a CDP-based system

Uniswap v4 provides the underlying swap/liquidity infrastructure.

Custom gUSD hooks are intended to implement protocol-specific behavior around areas such as:

- oracle pricing
- GPU asset issuance
- mint/burn behavior
- underwriting
- fees
- market/pool behavior

Exact mechanics remain subject to the protocol implementation.

The frontend should consume protocol functionality through appropriate adapters/services rather than embedding protocol assumptions deeply into UI components.

---

# Issuance

GPU asset issuance is tied to market demand/buy activity rather than representing a freely available unlimited mint interface.

---

# Liquidity Providers

GPU markets use Uniswap v4 liquidity infrastructure.

Liquidity providers remain an important participant in the system.

The frontend may eventually expose:

- liquidity
- LP positions
- pool participation
- fees/revenue
- pool statistics

The exact relationship between LP revenue, protocol fees, issuance mechanics, and hook behavior remains part of the protocol specification.

The web application should not duplicate functionality already naturally handled by Uniswap v4 unless gUSD-specific UX or hook behavior requires it.

---

# Oracle and Web Integration

The web application should not own oracle computation.

The long-term conceptual relationship is:

```text
GPU pricing sources
       ↓
Oracle / Index infrastructure
       ↓
gUSD data interfaces
       ↓
apps/web
```

The web application should be structured so that mocked data can later be replaced cleanly with:

- real Index feeds
- historical pricing APIs
- provider data
- onchain oracle values
- protocol market data

UI components should consume application/domain interfaces rather than knowing whether information came from:

- mocks
- an API
- an indexer
- RPC
- an oracle
- a contract

---

# Onboarding

gUSD intends to use Privy as the authentication and wallet infrastructure.

The product must support both major user groups from launch.

## Existing crypto users

Users with existing wallets should be able to connect and use them directly.

Examples include:

- browser wallets
- WalletConnect-compatible wallets
- hardware-wallet-backed external wallets

External-wallet users should retain their external wallet as their primary wallet.

The application should not automatically create an unnecessary embedded wallet for a user who already has one.

Wallet users may authenticate using SIWE where authenticated application state is required.

---

## Users without wallets

Users without an existing wallet should be able to authenticate using methods such as:

- email
- Google
- other supported social authentication

They can then receive a Privy embedded wallet.

The intent is that wallet infrastructure should not be a prerequisite for understanding or accessing GPU financial markets.

---

# Public Access

gUSD is also an information product.

Public product surfaces must not require authentication.

Users should be able to access:

- Markets
- GPU asset pages
- Index
- charts
- provider/reference pricing
- Data information
- Protocol information

without logging in or connecting a wallet.

Authentication should occur contextually when users attempt actions such as:

- trading
- earning
- depositing
- withdrawing
- managing a portfolio
- using account-specific functionality

There should be no mandatory login wall on arrival.

---

# Authentication Abstraction

Privy should remain underlying infrastructure rather than becoming the product architecture.

The application should avoid spreading Privy-specific models/types throughout the domain layer.

Conceptually:

```text
UI
 ↓
application/domain interfaces
 ↓
auth + wallet adapters
 ↓
Privy
```

This preserves the ability to evolve wallet infrastructure later without rewriting the product.

---

# Future Trading UX

The system may eventually support more advanced wallet and trading functionality such as:

- smart accounts
- transaction batching
- session permissions
- delegated trading
- gas sponsorship
- transaction policies
- limit orders
- automated execution

These are future capabilities, not requirements for the initial product shell.

The frontend architecture should not unnecessarily prevent them.

---

# Product Audiences

The application serves multiple overlapping audiences.

## GPU and AI Market Participants

Users interested in:

- GPU pricing
- market trends
- provider pricing
- Index values
- historical GPU economics

They may never connect a wallet.

---

## Traders

Users interested in:

- GPU asset exposure
- price movements
- basis
- market opportunities
- execution
- liquidity
- portfolio positions

---

## Capital Participants

Users interested in:

- gUSD
- sGUSD
- yield
- vaults
- liquidity
- LP economics
- protocol capital deployment

---

# Product Shell Phase

The current implementation phase is focused on building the complete web-product shell before all underlying infrastructure is production-ready.

During this phase:

- use realistic structured mock data
- use prototype interactions
- isolate mock implementations behind interfaces
- do not scatter fake values through UI components
- do not pretend mock actions are real transactions
- do not invent unresolved protocol mechanics
- make all major product relationships visually understandable

The web application should be built so that future integrations can replace mocks without requiring the product UX to be redesigned.

Examples:

```text
Mock market data
        ↓
real gUSD market/index API
```

```text
Mock trade execution
        ↓
wallet + Uniswap v4 + gUSD hooks
```

```text
Mock authentication
        ↓
Privy
```

```text
Mock portfolio
        ↓
wallet balances + protocol positions
```

---

# Initial Product Surfaces

The intended application currently includes:

```text
/
 /markets
 /terminal/[asset]
 /oracle
 /portfolio
 /protocol
```

The Oracle is one tabbed surface (`/oracle` — Overview, Benchmarks,
Methodology, Health, Developers) with query deep links (`?tab=`,
`&bench=`). Retired routes redirect permanently: `/earn` and `/vaults` to
`/gusd`, the per-GPU oracle sheet `/oracle/[asset]` and `/index`,
`/index/[asset]` into the Oracle's Benchmarks tab (`/oracle?tab=benchmarks`
with the benchmark selected), `/data` into its Developers tab,
`/markets/[asset]` to `/terminal/[asset]` — asset detail and trading share
one roof — and `/terminal` to the default desk, `/terminal/H100`: the
Terminal has no unbound form, it always shows one market's desk.

The exact routing may evolve as the product develops.

The product hierarchy matters more than preserving these exact URLs.

## Brand commitments

- **Multi-phosphor terminal.** The product's visual world is the palette of a
  full-color multi-phosphor CRT terminal, rendered clean: green phosphor
  carries the data field, amber owns function/headers/active state, cyan owns
  the Index wire, muted red/green own direction. CRT is a color reference
  only — no scanlines, glow, flicker, or curvature effects. Pinned by the
  user on 2026-09-05 ("complete retro CRT based trading terminal UI";
  phosphor fork: full color multi-phosphor; depth clarification: "CRT
  reference was only for colors. Not the effects like flicker or whatever";
  front door: straight to the board). The complete product shell ships: every
  surface in Initial Product Surfaces exists and works on mock data behind
  the ports. The front page presents all GPU markets as equals — never
  a single leading issue. Consumer dashboard idioms (cards, glows, rounded
  chrome, gradients) are out of world.
