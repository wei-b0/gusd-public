# AGENTS.md

## Purpose

This directory contains the onchain implementation of the gUSD protocol.

The protocol contracts are built with **Solidity + Foundry** and integrate with **Uniswap v4**.

Before planning or modifying contracts, read:

1. `PROTOCOL.md`
2. the existing contracts and tests
3. the repository-level `AGENTS.md`, if present

`PROTOCOL.md` is the canonical source for protocol behavior and economic intent.

Do not redesign the economics while implementing the contracts.

---

# Working Principles

## Preserve protocol semantics

Implementation decisions may change.

Protocol semantics may not.

Examples:

- contracts may be combined or separated,
- libraries may be introduced,
- storage layouts may change,
- access-control implementations may change,
- naming may improve,

provided the economic behavior and invariants defined in `PROTOCOL.md` remain intact.

If implementation convenience conflicts with a protocol invariant, preserve the invariant.

---

# Technology

Use:

- Solidity
- Foundry / Forge
- OpenZeppelin where appropriate
- Uniswap v4 core/periphery
- native Uniswap v4 liquidity and swap mechanics wherever practical

Do not recreate functionality already provided correctly by Uniswap v4 or OpenZeppelin without a concrete reason.

---

# Development Workflow

For substantial work:

1. Read `PROTOCOL.md`.
2. Inspect all relevant existing code.
3. Inspect current tests.
4. Inspect relevant Uniswap v4 interfaces and implementation details.
5. Produce an implementation plan before changing code.
6. Identify unresolved protocol decisions separately from engineering decisions.
7. Implement the smallest coherent milestone.
8. Add unit and invariant tests.
9. Run the full Foundry test suite.
10. Summarize architectural decisions made during implementation.

Do not begin by writing a large monolithic `GPUHook`.

Build and validate the monetary primitives first.

---

# Initial Implementation Order

Unless the current repository has already progressed beyond these stages, prefer:

## Milestone 1 — gUSD

Implement the USDC-backed gUSD monetary base.

Required behavior:

```text
USDC
  ↓
gUSD

gUSD
  ↓
USDC
```

The initial reserve model is fully backed and intentionally simple.

---

## Milestone 2 — sgUSD

Implement the savings/revenue-sharing layer on top of gUSD.

Prefer a share-based model such as ERC-4626 unless repository constraints or identified protocol requirements justify otherwise.

---

## Milestone 3 — GPU assets and primary issuance

Implement:

- canonical GPU identification,
- generic GPU token behavior,
- GPU registry/configuration,
- mock GPU oracle,
- primary GPU issuance,
- GPU issuance reserve accounting,
- issuance fees.

Start with one GPU, preferably:

```text
H100_SXM_80GB
```

before enabling the full initial catalogue.

---

## Milestone 4 — Uniswap v4

Integrate:

```text
GPU / gUSD
```

markets with Uniswap v4.

Start with:

```text
H100 / gUSD
```

before expanding to all GPU assets.

The first integration should prefer native v4 market mechanics.

Do not implement a custom AMM unless a protocol requirement demonstrably cannot be achieved with native v4 functionality plus hooks.

---

## Milestone 5 — GPUHook

Add only protocol-specific behavior that belongs in the hook.

Possible responsibilities include:

- canonical GPU pool validation,
- pool-to-GPU association,
- oracle reads,
- oracle freshness checks,
- oracle/market deviation measurements,
- protocol hook fees,
- dynamic fees,
- primary issuance coordination,
- market safety rules.

Do not assume all of these belong in V1.

Keep the hook as small as practical.

---

# Oracle Integration Boundary

Another agent is independently building the GPU oracle and price publication system.

Contract development must not depend on that implementation being complete.

Use an interface and a mock implementation.

The exact final interface should be kept minimal.

Conceptually:

```solidity
interface IGPUPriceOracle {
    function getPrice(bytes32 gpuId)
        external
        view
        returns (
            uint256 price,
            uint256 updatedAt
        );
}
```

The final signature may change if required by the production oracle.

Before changing shared oracle semantics, coordinate around:

- canonical GPU IDs,
- price decimals,
- timestamp semantics,
- staleness behavior.

Do not embed provider/indexer logic into protocol contracts.

## Production oracle (implemented)

The publication path is no longer hypothetical. The coordination points above
are now fixed in code on both sides:

- `src/oracle/GPUPriceOracle.sol` is the production oracle: publisher-EOA
  `publish()`, 2-step publisher rotation, owner-only `setPriceOverride()`
  escape hatch (genesis seeding + incident response), optional owner-settable
  `maxDeviationBps` deviation bound (ships disabled).
- The offchain publisher (`apps/publisher`, `PUBLISHER_TARGET=chain`) encodes
  and submits `publish()`. Its encoder mirrors `src/libraries/GpuId.sol` and
  the scaling below in `apps/publisher/src/encoding.ts`.

Encoding contract (changing any of it requires cross-stack coordination):

- `gpuId` — bytes32 left-aligned printable-ASCII SKU (0x21..0x7E, 1–32 bytes),
  bijective with the `packages/gpu-catalog` string IDs.
- `price` — USD per GPU-hour × 10_000 (4-decimal fixed point).
- `updatedAt` — unix seconds of the observation; the oracle clamps a future
  value to `block.timestamp` on write, so consumers never see a future stamp.
- Staleness is a consumer concern (`GPUIssuance.maxOracleStaleness`), not an
  oracle concern.

---

# Canonical Initial GPU Universe

The initial tokenized/onchain target catalogue is:

```text
A100_SXM_80GB
H100_SXM_80GB
H200_141GB
B200_192GB
B300_288GB
GB200_192GB
GB300_288GB
```

The oracle/indexer may support many more GPUs.

Oracle support does not imply tokenization.

Tokenization does not automatically imply that every feature must be enabled for that GPU.

---

# Testing Requirements

Use Foundry tests extensively.

At minimum include:

- unit tests,
- fuzz tests where useful,
- invariant tests for monetary/accounting invariants,
- integration tests for Uniswap v4 flows.

High-value invariants include:

```text
gUSD cannot be created without eligible reserve assets.
```

```text
GPU-token supply cannot increase outside authorized primary issuance.
```

```text
Primary GPU issuance must result in the required gUSD entering GPU issuance accounting.
```

```text
Secondary GPU trades must not silently modify primary issuance reserves.
```

```text
LP capital must never be treated as the solvency backstop for GPU-token appreciation.
```

```text
GPU-token holders must not acquire an implicit oracle-NAV redemption claim.
```

Prefer invariant-driven design over testing only expected happy paths.

---

# Uniswap v4

Understand v4 before implementing hook behavior.

Important properties include:

- pools are identified by `PoolKey` / `PoolId`,
- one hook is associated with a pool,
- one hook may service multiple pools,
- hook permissions are encoded into the deployed hook address,
- hook deployment may therefore require CREATE2 address mining,
- native concentrated liquidity does not require a fixed 50/50 token ratio,
- custom accounting exists but should only be used when it solves a real protocol requirement.

Use official Uniswap v4 contracts and test infrastructure where appropriate.

---

# LP Semantics

LPs are ordinary liquidity providers.

Their role is:

```text
provide liquidity
       ↓
facilitate GPU/gUSD trading
       ↓
earn fees
```

They are not:

- GPU-price underwriters,
- synthetic short counterparties,
- responsible for token-holder profits,
- protocol solvency backstops,
- guarantors of oracle-price redemption.

LPs still inherit ordinary AMM risks.

Do not add hidden GPU liability exposure beyond normal market-making behavior.

---

# Primary vs Secondary Market

Keep these concepts separate.

Primary issuance:

```text
gUSD
  ↓
GPU issuance
  ↓
new GPU-token supply
```

Secondary trading:

```text
GPU token ↔ gUSD
       Uniswap v4
```

Ordinary secondary-market buys and sells should not automatically mint and burn GPU tokens.

---

# Planning Guidance

The implementation planner is expected to decide:

- contract boundaries,
- libraries,
- role/access-control architecture,
- storage organization,
- deployment architecture,
- how much functionality belongs in `GPUHook`,
- whether some conceptual components belong in the same contract,
- the best test harness architecture.

Do not blindly translate conceptual diagrams into one Solidity contract per box.

Prefer the smallest architecture that preserves protocol boundaries and can be reasoned about securely.

---

# Open Protocol Questions

Do not silently invent answers to unresolved economic questions.

Current areas that may still require design decisions include:

- exact primary issuance availability rules,
- issuance fee parameters,
- below-oracle supply management,
- GPU reserve withdrawal/use rules,
- dynamic fee policy,
- protocol revenue split,
- sgUSD revenue distribution details,
- protocol-owned initial liquidity,
- governance and emergency controls.

Where these do not block a milestone, keep them configurable or out of scope.

Where they do block implementation, explicitly identify the decision before proceeding.

---

# Security Philosophy

Treat this as financial infrastructure.

Prefer:

- explicit accounting,
- minimal trust assumptions,
- small contract surfaces,
- checks-effects-interactions,
- pull over push mechanics where appropriate,
- narrow roles,
- immutable parameters where practical,
- clear pause/emergency boundaries,
- externally auditable state,
- simple invariants.

Avoid cleverness that is not necessary.

Do not sacrifice economic clarity for gas optimizations during the first implementation.

---

# V1 Non-Goals

Unless explicitly requested, V1 does not require:

- GPU-token oracle-NAV redemption,
- GPU-collateralized borrowing,
- liquidations,
- lending,
- derivatives,
- shorts,
- cross-chain deployments,
- algorithmic stablecoin mechanics,
- reserve yield strategies,
- custom AMM curves,
- automated protocol buybacks,
- shared automated LP vaults,
- governance token mechanics.

Build the smallest complete protocol first.

---

# Definition of Success

The first meaningful end-to-end implementation should demonstrate:

```text
USDC
  ↓
gUSD
  ↓
primary H100 issuance
  ↓
H100 exists in user wallet
  ↓
H100/gUSD Uniswap v4 market
  ↓
buy/sell H100
  ↓
LP earns normal market fees
  ↓
protocol earns configured revenue
  ↓
revenue can accrue to sgUSD
```

All of this must occur without:

```text
LP underwriting GPU appreciation
```

and without:

```text
guaranteed GPU-token redemption at oracle NAV.
```
