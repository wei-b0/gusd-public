# FEEDBACK.md — gUSD on Uniswap v4

## Project

**gUSD — The GPU Assets Protocol.** Onchain spot markets for exposure to GPU
compute prices. Each launch GPU (H100, H200, L40S, RTX 4090) trades against
the protocol's settlement asset, gUSD, through a canonical Uniswap v4 pool on
Robinhood Chain mainnet (chain ID `4663`).

- **Live app:** https://gusd.lol
- **Public repository:** https://github.com/wei-b0/gusd-public
- **Uniswap v4 integration map** (contracts, addresses, line-level code
  pointers): [`docs/uniswap-integration.md`](docs/uniswap-integration.md)
- **Chain:** Robinhood Chain mainnet · `4663` · start block `61390610`

## What we built on v4

gUSD's GPU markets are a v4 hook market — not a passive pool. The protocol
reuses Robinhood Chain's **canonical PoolManager** (`0x8366…0951`) so markets
settle against the chain's existing v4 liquidity infrastructure rather than a
second deployment, and layers a custom hook on top:

- **`GPUHook`** — a single hook that reads a guarded price oracle inside every
  swap, derives oracle-anchored bid/ask edges, simulates the native book's
  walk to the edge, and fills everything beyond the edge from protocol-owned
  inventory — with primary issuance as the in-swap backstop. One swap call is
  the complete market.
- **`GpuRouter`** — the product surface: `buy` / `sell` / `buyExactIn`, one
  transaction each, through the PoolManager unlock.
- **`GpuQuoter`** — a lens that quotes the **real** pool's **real** hook by
  executing it inside a PoolManager lock against float balances.

Permission mask `0x10CC` (`afterInitialize`, `beforeSwap`, `afterSwap`, both
swap return-delta flags), mined into the hook's deployed address.

## Feedback on building with v4

### What was excellent

1. **The singleton + flash accounting made "one swap is the whole market"
   possible.** The hook composes native LP flow, protocol-owned inventory,
   and an issuance backstop inside a single swap — `beforeSwap` plans,
   `afterSwap` realizes, and the `BeforeSwapDelta` return mechanism is what
   lets the hook absorb beyond-edge input and hand back output without
   breaking the PoolManager's accounting. This design is simply not expressible
   on v2/v3.
2. **The stateless plan/realize split held up in production.** Because
   `afterSwap` recovers the absorbed amount from the native `swapDelta` and
   re-derives every spend from a fresh guarded oracle read, the hook carries
   no transient state between phases — safe under nested swaps and reentrancy
   by construction. The v4 primitives (deltas as the only channel between the
   two phases) pushed us toward this design and it paid off.
3. **Canonical infra reuse was real.** Deploying against Robinhood Chain's
   existing PoolManager / PositionManager / Permit2 meant zero liquidity
   fragmentation and standard tooling (StateView, Quoter, Permit2) worked
   out of the box.

### What was hard

1. **Hook size vs. EIP-170.** The hook's walk machinery had to be extracted
   into a self-deployed helper (`PoolWalk`) because external library linking
   would change `type(GPUHook).creationCode` and break CREATE2 address mining
   against the permission-bit mask. A supported pattern for composing larger
   hooks with address-preserving code layout would help.
2. **Fee accounting across the two phases.** The specified delta is frozen at
   `beforeSwap`; only the output leg is adjustable in `afterSwap`. Charging a
   buyer a fee in the input currency is therefore impossible — our fee is
   taken out of the absorbed budget instead. A first-class way to reserve
   fees at plan time would remove a class of subtle reasoning.
3. **Quoting hook pools has no answer in the box.** v4 ships quoters for
   vanilla pools; a hook that injects its own fills mid-swap cannot be quoted
   with them. We built `GpuQuoter` (run the real hook in a real lock, seed
   floats, parse the revert payload) — a documented pattern or primitive for
   "simulate this hook pool honestly" would be broadly useful.

## Feedback form

Submitted at https://developers.uniswap.org/hackathon-feedback — the
submission links to this file (`FEEDBACK.md` at the repository root).
