# gUSD Pull-Oracle Migration Plan (push → caller-funded attestation)

**Status: PLAN ONLY — no implementation.** All references are to the current codebase on `main` (23a0ae9), audited as source of truth.

Goal: the oracle engine computes prices offchain → signed attestation → Oracle API → caller includes the attestation in the SAME trade tx → contract verifies/consumes it → execution. No separate oracle-update tx.

Requirements: 0 continuous oracle EVM OpEx when idle; no gas-funded publisher daemon as chain-liveness dependency; 0.9% publication threshold + 24h heartbeat removed; UI stays API-driven; every BUY/SELL/issuance/price-dependent execution uses a current authenticated report, never a cached price; caller pays verification gas; report schema reusable later for perps (not implemented here).

**Critical invariant:** if cached H100=$2.50 but the executable report says $2.65, NO path may execute at $2.50.

---

## 1. Current flow

**Offchain → chain (push):**

1. Collectors → `packages/pricing-engine` (`computeIndex`, `aggregateProviderPrice`: `median` / `volume_weighted_median` / `thin_book_holdout`) → candidates persisted to Postgres `index_candidates` (append-only; dedup on `(gpu_id, calc_hash)`; status `healthy|degraded|stale|withheld|frozen`; `calc_hash` pins the engine receipt; `methodology_versions.config_hash` pins methodology).
2. `apps/publisher` (`poller.ts:tickInner`, 5s single-flight): reads candidates **directly from Postgres** (only HTTP is `GET /v1/health` for breaker state), validates via `validate.ts:assessCandidate` (missing_price hard stop; stale > 300s; methodology mismatch; quorum; dispersion; band width; `jump_requires_manual` @ 0.25; breaker majority), then the **publish trigger** (`poller.ts:155-177`): publish only if deviation ≥ **0.9%** (`PUBLISHER_MIN_DEVIATION_PCT`) OR heartbeat ≥ **24h** (`PUBLISHER_HEARTBEAT_MS`).
3. `chain-target.ts:publish` → `viem-chain-client.ts:sendPublish` (hot EOA, pinned `maxFeePerGas` 0.05 gwei, 1 confirmation) → **`GPUPriceOracle.publish(gpuId, price, updatedAt)`** (`GPUPriceOracle.sol:61`; `_write` :106-124 clamps `updatedAt` to `block.timestamp`).
4. `GPUPriceOracle` stores `_price[gpuId]` / `_updatedAt[gpuId]`; sole contract surface is `IGPUPriceOracle.getPrice(bytes32) → (price, updatedAt)`. Owner hatch `setPriceOverride` (:71) seeds genesis. Publisher is a 2-step-rotated role (:77-90).
5. **Consumers read the cache on every use:**
   - `GPUIssuance._oraclePrice` (`GPUIssuance.sol:333-339`) — zero / future / stale (25h, :58) guards; used by `issue` (:161), `issueCredited` (:202), `quoteIssue` (:257), `quoteIssueCredited` (:236), `referenceSqrtPriceX96` (:295); `oracleSqrtPriceX96` (:278) reads unguarded.
   - `GPUHook._oraclePrice` (`GPUHook.sol:237-248`) — same guards, but **soft-fails** (`ok=false`).
6. **`GPUHook.beforeSwap` (:257): on `!ok` returns ZERO_DELTA (:266-268) → the swap continues pure-native.** Same degrade on walk-cap/no-work paths (:302-303, :311-313). `afterSwap` (:601) re-reads the oracle fresh (:609) and soft-fails `!ok → return 0`; its `bytes calldata` hookData param (:606) is unused today. Pricing flows into `_plan` (:325) → `_buyLadder` (:500; POL ask + issuance backstop via `issuance.quoteIssueCredited` :545/:562) and the four settle fns (:657/:702/:737/:796). All router/quoter swaps pass **empty hookData** (`GpuRouter.sol:275,305,337`; `GpuQuoter.sol:289`).
7. `GpuRouter`: `buy` (:127; **genesis fallback** :153-160 → `issuance.issue` when `hook.poolGpuId == 0`), `buyExactIn` (:181), `sell` (:217) — none touch the oracle; they inherit cached pricing only through hook/issuance.
8. Web (`apps/web`): display price = oracle API HTTP/SSE feed (`m.marketPrice ?? m.indexPrice`); quotes = `GpuQuoter` lens + `issuance.quoteIssue` (`data/web3/trading/quotes.ts:309,419,485,612`) and the TS mirror `hook-quote.ts` (`oracleGuardOk`:140, `issuanceGuardOk`:146). `TradingPort.execute` → `action-runner.ts` builds approvals + router calldata. **No attestation concept exists.**
9. Indexer: `generate-config.ts:37` subscribes to `GPUPriceOracle[PricePublished, PriceOverridden, PublisherAccepted, MaxDeviationBpsSet]` → `schema.graphql` `OraclePricePublished` (:192) / `OracleState` (:354) → `handlers/oracle.ts`; oracle API proxies via `protocol/sql.ts` (`oracle_price_published`, `oracle_state`, …).
10. Deploy: `Deploy.s.sol` — external `ORACLE` env or deploy `GPUPriceOracle` (:163-174); seed via `setPriceOverride` (:295-302); issuance (:218); **HookMiner CREATE2 with ctorArgs `(poolManager, gusd, oracle, issuance, ledger, deployer)`** (:223-231, mask 0x10CC); `setRefs`; router (:236); quoter (:243); pools initialized at `issuance.oracleSqrtPriceX96` (:340-352); `_persist` records `oraclePublisher` (:370). `Deploy.full.s.sol` drives the demo through `_setPrice`/`_repriceAndQuote` (:488-511) and asserts `quote == execution`.

## 2. Gaps

- **G1 — publisher daemon is a chain-liveness dependency:** no publisher txs → 25h later all issuance reverts `OracleStale` and the hook silently goes native-only.
- **G2 — cache ≠ executable price (the invariant violation):** cached $2.50 with engine at $2.65 executes at $2.50 on every path until the next publish. There is no onchain notion of "the current report."
- **G3 — fail-open hook:** `beforeSwap:266` stale → ZERO_DELTA → native swap; direct `PoolManager.swap` with empty hookData bypasses all protocol logic on canonical pools.
- **G4 — direct issuance bypass:** `GPUIssuance.issue` (:161) is permissionless against the cache.
- **G5 — continuous EVM OpEx:** deviation publishes (every 0.9% move) + 24h heartbeats × 4 SKUs, even with zero users.
- **G6 — publication policy gates truth:** 0.9%/24h decide when the chain sees the price; the EVM can't know what it's missing.
- **G7 — quote/execution divergence:** quoter + mirrors quote the mutable cache; nothing binds quote price to execution price.
- **G8 — indexer models publication, not consumption.**
- **G9 — duplicated, weak freshness semantics:** two independent `maxOracleStaleness` (25h) knobs; single `updatedAt` field.

## 3. Target architecture

```
collectors → pricing engine → index_candidates (unchanged, offchain)
                 ↓
       apps/attestor (ex-publisher; no EVM role)
       assessCandidate → build Report → EIP-712 sign → persist reports → (no tx)
                 ↓
Oracle API  GET /v1/prices/:gpu/attestation → {report fields, signature, reportHash, updateData}
                 ↓
caller embeds updateData in the SAME trade tx:
  GpuRouter.buy/buyExactIn/sell ──► PoolManager.swap(..., hookData=updateData)
      └► GPUHook.beforeSwap: GpuOracle.verify once → price = report.price (fail-closed)
         GPUHook.afterSwap: same report via transient → same price, no re-verify
  GPUIssuance.issue / issueCredited (hook + genesis path) ──► verify/consume(report)
  GpuQuoter.quote* / web mirror ──► same updateData → execution-identical quotes
  GpuOracle: emit PriceConsumed once per (gpu, epoch); record lastConsumed* (observability only)
```

- **New `GpuOracle.sol` (+ `IGpuOracle.sol`):** pure verifier/consumer. Stateless `verify(Report, sig) → price`; `consume(Report, sig)` adds the once-per-epoch binding + event; transient per-tx dedupe so hook→issuance re-verification is a TLOAD. Per-GPU `lastConsumedPrice/At/Epoch/reportHash` storage is **observability only — never a price input** (NatSpec + tests enforce).
- `GPUPriceOracle` / `IGPUPriceOracle` / `MockGPUPriceOracle` retired from production wiring; `GPUIssuance.oracle` (:54) and `GPUHook.oracle` (:82) re-typed to `IGpuOracle`.
- `apps/publisher` → **`apps/attestor`** (recommended rename). No RPC, no wallet, no nonce, no gas. Signs with `ATTESTOR_PRIVATE_KEY`.
- UI stays API-driven; the attestation endpoint is additive.
- Perps-ready: report carries `observedAt`/`epoch`, so a later perp engine can require "order created T0 → consume report with `observedAt > T0`" with no schema change.

## 4. Report schema (V1, EIP-712)

```solidity
struct Report {
    uint16  version;     // 1
    bytes32 gpuId;       // canonical SKU bytes32 (GpuId.sol left-aligned ASCII)
    uint256 price;       // USD/GPU-hour × PRICE_SCALE = 10_000  (unchanged)
    uint64  observedAt;  // engine computation time (candidate.computedAt), unix sec
    uint64  epoch;       // observedAt / EPOCH_LENGTH
    uint64  validFrom;   // epoch * EPOCH_LENGTH
    uint64  validUntil;  // validFrom + EPOCH_LENGTH (exclusive)
    bytes32 calcHash;    // candidate.calc_hash — methodology/receipt binding
}
```

- **EIP-712 (evaluated and chosen):** domain `{name:"gUSD GPU Oracle", version:"1", chainId, verifyingContract:GpuOracle}` — typed, wallet-displayable, and kills cross-chain/cross-contract replay by construction; OZ `EIP712` provides `_hashTypedDataV4`. Raw EIP-191 would need hand-rolled domain logic and gives wallets an opaque blob. 65-byte `(v,r,s)` ECDSA.
- **Wire format `updateData = abi.encode(Report, signature)`** — one `bytes` that rides as router param → swap `hookData` → issuance arg; byte-identical across quote, simulation, execution.
- `validFrom/validUntil` are kept even though epoch equality already implies them: self-describing rejection reasons, explicit non-overlap, perps/limit-order reuse, and a path to relax acceptance later without a schema break.
- `reportHash = keccak256(updateData)` (binds signer too) — used for transient dedupe and the epoch binding.
- **`PRICE_SCALE = 10_000` kept.** Issuance math (`GPUIssuance.sol:174-175`, `compositionDivisor` :42/:101) untouched; the oracle's `PriceScaleMismatch` ctor check (:92-93) becomes moot and is dropped (price is caller-supplied and always scaled).

## 5. Epoch / freshness model

**Fundamental limitation, stated explicitly:** the EVM cannot know a newer offchain report exists. It can only accept what is derivable as *current* from onchain inputs. Therefore "current" is defined as pure `block.timestamp` arithmetic — the epoch — never by recency guessing.

- `currentEpoch() = block.timestamp / EPOCH_LENGTH`; `EPOCH_LENGTH` owner-set, default **60s**.
- **Acceptance (all checks, deterministic):** `version == 1`; signature valid for `signer()`; `gpuId` matches the consuming market; `price != 0`; `report.epoch == currentEpoch()`; `report.observedAt / EPOCH_LENGTH == report.epoch`; `observedAt <= block.timestamp`; `validFrom == epoch*EPOCH_LENGTH`; `validUntil == validFrom+EPOCH_LENGTH`; `observedAt >= now − MAX_OBSERVATION_AGE` (300s floor, mirroring attestor `maxFreshnessMs` — belt-and-braces, **not** the primary mechanism). At any instant exactly **one** epoch is acceptable → old and future reports are objectively non-executable.
- This **replaces** every `block.timestamp − updatedAt <= MAX_AGE` check: `maxOracleStaleness` in `GPUIssuance.sol:58` / `GPUHook.sol:92` and setters (:137, :918) are deleted.
- **Adversarial selection among multiple still-valid reports — explicitly solved:**
  - *Across epochs:* impossible; epochs are non-overlapping and equality-checked.
  - *Within one epoch:* first consumer's report wins — `consume` sets `lastConsumedEpoch/reportHash` only when `epoch > lastConsumedEpoch`, and later same-epoch consumers must present the **same reportHash** (1 SLOAD, write only on epoch roll). After first consumption the executable report is objectively unique and simulatable onchain. Before it, an honest signer produces one report per epoch, so there is nothing to select between; equivocation is onchain-attributable (every consumption logged) and economically pointless. Residual honest limitation: between epoch start and first consumption, equivocation is not onchain-resolvable — bounded to one binding per epoch, eliminated at root by signer security (§12, D5).
- **Wallet/mempool-latency balance:** strict epoch equality means a tx whose epoch rolls before inclusion reverts. Exposure ≤ 1 epoch at 60s; the web flow fetches the attestation as the *last* pre-sign step and auto-retries once on roll (§8). We deliberately reject a grace window over the previous epoch: overlap reintroduces adversarial selection, which the requirement forbids. Reverts are cheap; ambiguity is not.
- **First trade after days idle:** works — no onchain freshness state is needed; the API serves the current epoch's report on demand.

## 6. Contract changes

**New `src/oracle/GpuOracle.sol` + `IGpuOracle.sol`** (Ownable2Step for params only):

- `verify(Report calldata, bytes calldata sig) view returns (uint256 price)` — §5 guard set; typed errors `InvalidVersion, UnknownGpuEpoch, BadEpochBinding, StaleObservation, FutureObservation, ZeroPrice, GpuMismatch, InvalidSignature`.
- `consume(Report calldata, bytes calldata sig)` — verify + epoch binding + `PriceConsumed(bytes32 indexed gpuId, uint256 price, uint64 indexed epoch, uint64 observedAt, bytes32 indexed reportHash, address caller)` (only when `epoch > lastConsumedEpoch`). Permissionless — anyone may pre-warm an epoch.
- Transient dedupe: `TSTORE verified[reportHash]` for the tx; a second verify of the same bytes (hook → `issueCredited`) is a TLOAD — no second `ecrecover` (safe because bytes are identical).
- 2-step signer rotation `transferSigner/acceptSigner` mirroring `GPUPriceOracle.sol:77-90`; `signer()`.
- Getters `lastConsumedPrice/At/Epoch/ReportHash(bytes32)` — NatSpec: observability only.

**`GPUIssuance.sol`** (`oracle` immutable :54 re-typed):

- `issue(gpuId, amount, to, bytes updateData)` (:161) — price = `oracle.consume(...)`; direct issuance without a report reverts (closes G4).
- `issueCredited(gpuId, amount, to, maxGusdSpend, bytes updateData)` (:202) — hook-only gate kept (:211); consumes the same updateData the hook verified (transient dedupe); `InsufficientSpend` kept (:221).
- `quoteIssue` (:257) / `quoteIssueCredited` (:236) gain `updateData`; they **verify** (not consume) the exact report — a quote can only exist for a report execution would accept.
- Delete `_oraclePrice` (:333-339), `maxOracleStaleness` (:58) / setter (:137), `OracleStale/OracleFutureTimestamp`.
- `oracleSqrtPriceX96` (:278) / `referenceSqrtPriceX96` (:295) → `reportSqrtPriceX96(Report)` view (no staleness logic; deploy/tooling use). `IGPUIssuance.sol` updated in lockstep.

**`GPUHook.sol`** (`oracle` immutable :82 re-typed):

- `beforeSwap` (:257): decode `updateData` from the trailing `bytes calldata` (currently unnamed); require `report.gpuId == poolGpuId(key.toId())`. **Missing/invalid/expired/wrong-GPU report → revert `ReportRequired`** — the ZERO_DELTA degrades (:266-268, :302-303, :311-313) are removed; fail closed (closes G3).
- `afterSwap` (:601): **same price, same report** — `beforeSwap` pushes the verified price into a transient per-nesting-depth stack (TSTORE keyed by swap depth; LIFO-safe under v4 nested locks); `afterSwap` pops it. Removes the fresh re-read (:609) and its soft-fail. Defense-in-depth: if the transient is absent, re-verify from hookData rather than proceed.
- `_buyLadder` (:500) `quoteIssueCredited` calls (:545, :562) and `issueCredited` settles (:681, :768) pass the updateData; the four settle fns thread the report price. `polState` (:881) becomes report-parameterized + a `lastConsumedState` view. `DEFAULT_MAX_ORACLE_STALENESS` (:54) and `setMaxOracleStaleness` (:918) deleted. **Hook mask 0x10CC unchanged**; `GpuFill`/`HookSwap` events unchanged (price semantics now report-priced).

**`GpuRouter.sol`:**

- `BuyParams` (:84) / `SellParams` (:94) gain `bytes updateData`; `buyExactIn` (:181) takes it directly. `buy` (:127) forwards to genesis `issuance.issue` (:154) and encodes it into the unlock payload; `_unlockCallback` (:256) passes it as `hookData` in all three `poolManager.swap` calls (replaces `""` at :275, :305, :337). Router is a pass-through — never verifies. Deadline/slippage/fee logic untouched.

**`GpuQuoter.sol`:** all four entrypoints (:112, :118, :124, :131) gain `updateData`; `_swap` (:281) forwards it as hookData (replaces `""` :289). The lens runs the real hook with the exact report execution will use — quote == execution by construction. Float-seeding, `_finish` (:303), `QuoteResult` unchanged.

**Unchanged:** `GPUMarketLiquidity` (virtual-inventory vault; no placement code), `GPUToken`/`GUSD`/`sgUSD`/`RevenueLedger`/`StableRouter`, `PoolWalk` (`edgeSqrt` :27 already takes `price` as a parameter), `GpuId`, `GpuPoolKey`.

## 7. Oracle / attestor

- **Rename `apps/publisher` → `apps/attestor`** (recommended: its old job — chain writes — is deleted).
- **Deleted:** `chain-target.ts` (`verify` :74-93, `publish` :95-102), `viem-chain-client.ts` (`sendPublish` :60-82), `target.ts` mock-chain mode, the publish trigger in `poller.ts:155-177` (0.9% + heartbeat), env `PUBLISHER_RPC_URL / PUBLISHER_ORACLE_ADDRESS / PUBLISHER_CHAIN_ID / PUBLISHER_MAX_FEE_GWEI / PUBLISHER_TX_TIMEOUT_MS / PUBLISHER_TARGET` (private key kept, renamed `ATTESTOR_PRIVATE_KEY` — signing only, never broadcast).
- **Preserved:** `validate.ts:assessCandidate` (quorum, dispersion, band width, freshness 300s, jump flag, breaker majority — `missing_price` remains the only hard stop; `jump_requires_manual` stays flagged-not-blocking), `thresholds.ts` tighten-only merge, methodology pin, `encoding.ts` (`PRICE_SCALE` :18, `priceToScaled` :56-71, `encodeGpuId`), idempotency becomes "one report per `(gpu_id, epoch)`".
- **New loop:** candidate accepted → build `Report` (`observedAt = candidate.computedAt` clamped ≤ now; skip if older than `MAX_OBSERVATION_AGE`; `epoch = observedAt / EPOCH_LENGTH`; re-attest the latest healthy candidate into each new epoch within the floor) → EIP-712 sign (viem `signTypedData` with the exact domain) → persist to new `reports` table in `packages/db` (gpu_id, price, observed_at, epoch, valid_from, valid_until, calc_hash, signature, report_hash, attested_at; unique `(gpu_id, epoch)`) → API serves. **No EVM tx anywhere.**
- **Oracle API** (`apps/oracle/src/server.ts`): add `GET /v1/prices/:gpu/attestation` beside the existing routes (:171-:390), resolving `:gpu` via `protocol/gpu-id.ts:resolveGpuParam`; returns `{version, gpuId, price, observedAt, epoch, validFrom, validUntil, calcHash, signature, reportHash, updateData}` for the current epoch; `404 no-report-for-epoch`, `503 attestor-degraded`; `Cache-Control: no-store`. Everything else — `/v1/prices`, history, candles, providers, health, WS/SSE stream, `/v1/protocol/*` proxy — unchanged.
- One shared TS codec (new `packages/attestor-client`) is the single source of report encoding for attestor + API + web, cross-tested against Solidity (§14).

## 8. Web / quotes

- **Quotes** (`data/web3/trading/quotes.ts`): `quoteBuy:309`, `quoteSell:419`, `quoteBuyBySpend:485`, `quoteSellByProceeds:612` take the report; `GpuQuoter` reads and `issuance.quoteIssue` (:333, :513) pass `updateData`; `hook-quote.ts` mirrors re-derive from `report.price`, replacing `oracleGuardOk`/`issuanceGuardOk` (:140-148) with epoch/validity checks. Quotes without a report are impossible — matching the contract.
- **Submit lifecycle** (`onchain-trading-port.ts`, `action-runner.ts`, `approvals.ts`): API preview → quote (slip shows report R₀) → user submits → **approvals first** → **fetch fresh attestation R** → **re-quote/simulate with exactly R** (GpuQuoter `eth_call` or mirror) and check against user-accepted bounds → build calldata embedding **R** → sign → broadcast atomically. If R expires during approvals/signature → auto-retry once (new fetch → rebuild → re-sign), then a typed "report expired" action record. `order-slip.tsx` displays the executable report price, epoch, and validity countdown; banner prices stay the API feed, but the slip must be derived only from report quotes (invariant-tested).
- **Reads:** `reads.ts` / `abis/gpu_price_oracle.ts` (`getPrice`, `publish`) replaced by API prices for display + `GpuOracle.lastConsumed*` for "last executed onchain"; `addresses.generated.ts` / `contracts.ts` re-wired from the new deployment record; ABIs regenerated via `scripts/abi-sync.mjs`.

## 9. Indexer

- `scripts/generate-config.ts:37`: replace the `GPUPriceOracle` block with `GpuOracle[SignerTransferStarted, SignerAccepted, PriceConsumed]` (`abis/oracle.json` regenerated); hook/issuance/router event sets unchanged.
- `schema.graphql`: drop `OraclePricePublished` (:192) / `OraclePriceOverridden` (:203) / `OracleState` (:354); add `PriceConsumed {gpuId, price, epoch, observedAtSec, reportHash, caller}` + `GpuOracleState {gpuId, lastConsumedPrice, lastConsumedAtSec, lastConsumedEpoch, lastReportHash}`. **Consumption is recorded once per (gpu, epoch) — the chain never sees offchain observations.**
- `handlers/oracle.ts` rewritten for the new events; hook/wallet/bucket handlers untouched. `protocol/sql.ts` proxy map updated (`oracle_price_published`/`oracle_state` → `price_consumed`/`gpu_oracle_state`). Candles/history keep coming from `index_candidates` (public.*) — unaffected.

## 10. Deployment

- **Immutables:** `GPUIssuance` ctor (:86) and `GPUHook` ctor (:141) re-typed to `IGpuOracle`; hook ctorArgs change → **new CREATE2 address → new pool identity** (PoolKeys embed the hook address via `GpuPoolKey.canonical`). Clean redeployment preferred: fresh pools, fresh deployment record, no compat shims.
- **Existing Robinhood-mainnet state:** pools keep the old hook/oracle; their fate is decision D3. Old POL principal has **no withdrawal path** (`GPUMarketLiquidity` custody invariants) — exit only by trading it out through old pools, or abandon.
- **`Deploy.s.sol`:** deploy order → `GpuOracle` first; delete `setPriceOverride` seeding (:295-302) and `SEED_PRICE` mainnet guards (:132-141); `_initializeCanonicalPool` (:340-352) uses a static env seed sqrt (bootstrap/display only — every trade still needs a current report); `_persist` (:354) records `oracleAttestor` (signer address) instead of `oraclePublisher` (:370).
- **`Deploy.full.s.sol`:** `_setPrice`/`_repriceAndQuote` (:488-511) replaced by a test-attestor helper (`vm.sign` typed data → `updateData`) feeding every demo buy/sell; genesis buys (:185-208) and all `quote == execution` asserts (:311-325, :351-380, :401-423) become report-driven. Anvil dev tooling: `MockAttestor` script/key replaces `MockGPUPriceOracle`.
- **Bootstrap when no report has yet been consumed:** pools initialize empty at the seed sqrt; POL zero; the first `buy` requires a live current-epoch attestation — deploy script verifies attestor liveness (fetch → simulate → proceed). Fail-closed and honest: no trade can precede the attestor.
- Regenerate `deployments/<chainId>.json`, web `addresses.generated.ts`, ABI sync, indexer `runtime-config.ts` (`generate-config.ts:21-26`).

## 11. Failure semantics

| Case | Behavior |
|---|---|
| Attestor/API/DB down | No current-epoch report → all price-dependent execution reverts (`ReportRequired`); UI shows "oracle unavailable". Honest market-closed; no stale fallback. |
| No valid report for the epoch | Same — fail closed on hook, issuance, genesis, quotes. |
| Expiry before inclusion / delayed mempool tx | Reverts (epoch rolled); UI auto-refetches + retries once; user pays only gas. |
| Wrong signer / GPU / chain / contract | `InvalidSignature` / `GpuMismatch` / EIP-712 domain rejection. |
| Zero / future / stale-observation / old-epoch report | `ZeroPrice` / `FutureObservation` / `StaleObservation` / `UnknownGpuEpoch` (strict equality — never a recency guess). |
| Duplicate identical report | Idempotent — transient dedupe, binding check passes, no double event. |
| Newer report exists offchain but isn't submitted | EVM cannot know; only `block.timestamp/EPOCH_LENGTH` is executable. The API always serves the current epoch — the UI path never has this gap. |
| Empty-hookData direct `PoolManager.swap` | `beforeSwap` reverts `ReportRequired` — no native degradation. |
| Direct `issue()` without report | Reverts. |
| Compromised signer | One report per epoch (binding), full onchain attribution, 2-step rotation, optional consumption pause. |
| Huge legitimate jump | Allowed onchain (0.9% concept deleted); offchain jump flag remains advisory; POL caps (`GPUHook.sol:52-53`) are the economic breaker. |
| UI price ≠ execution report | Slip built from report quotes; out-of-bounds re-quote aborts before signing. |

## 12. Threat model

- **Wrong signer:** EIP-712 domain + `signer()` check; 2-step rotation; in-flight txs from the old signer revert after acceptance (≤1 epoch).
- **Signer compromise:** worst case = attacker picks prices within epoch bounds, capped by first-consumed binding + onchain `PriceConsumed`/`lastReportHash` audit trail; response = rotate (2-step) / pause. V1 keeps a single signer, matching today's single-publisher-key trust; threshold attestor is a later upgrade (D5).
- **Tampering:** any field edit breaks the typed digest; `calcHash` binds to a reproducible engine receipt (auditable via `/v1/prices/:gpu/history` + `replay-candidate.ts`).
- **Replay:** same tx re-run in the same epoch → idempotent (binding check passes; swap itself protected by allowances/deadline). Old epoch → `UnknownGpuEpoch`.
- **Cross-chain / cross-contract replay:** domain `chainId + verifyingContract`.
- **Old/future report games:** epoch equality + `observedAt ≤ now` + `observedAt` epoch-binding + 300s floor.
- **Bypass:** all four surfaces (router pool path, router genesis path, direct PoolManager swap, direct issue) require a verified current report — test-proven (§14).
- **Attestor equivocation:** detectable onchain, economically neutralized by first-consumed binding.
- **Huge legitimate jumps:** no onchain bound by design; POL caps remain.

## 13. Gas / OpEx

- **Idle: 0 oracle EVM txs.** Attestor signs offchain continuously (free); nothing touches the chain. Publisher tx costs, EOA funding, and monitoring disappear.
- **First consumer of an epoch:** decode (~1k) + ecrecover (~3k) + epoch-binding SSTORE (~20k cold, amortized over the epoch's users) + one `PriceConsumed` log ≈ +25-45k gas on the epoch's first trade; mid-epoch consumers pay decode + ecrecover (binding SLOAD warm, no SSTORE).
- **Same-report re-verification (hook → `issueCredited`):** TLOAD dedupe — no second ecrecover, no SSTORE, no duplicate event.
- **Caller pays** everything; no protocol subsidy path exists.

## 14. Tests (minimum set)

- New `test/unit/GpuOracle.t.sol`: valid / tampered / wrong-signer / wrong-chain (domain) / wrong-GPU / zero price / future / stale-observation / old-epoch / future-epoch / duplicate / epoch-binding (first-consumer-wins, later different report reverts) / price-scale 10_000 parity / signer rotation / observability-not-a-price.
- `test/unit/GPUHook.t.sol` (updated): no-report swap reverts; empty-hookData direct PoolManager swap reverts; **cached $2.50 state + $2.65 report executes only at $2.65**; stale report never degrades to native-only; before/after same price incl. nested swaps; POL/backstop/fees/exact-in/out golden values unchanged.
- `test/unit/GPUIssuance.t.sol` (updated): issue/issueCredited/quote* with and without report; direct issuance cannot bypass; quote == execution for identical updateData.
- `test/unit/GpuRouter.t.sol` + `test/integration/E2E.t.sol`: report propagation through buy (pool + genesis), buyExactIn, sell; **long-idle first trade succeeds** (warp days → fresh report → trade); quote==execution e2e.
- `test/integration/OraclePublication.t.sol` → rewritten `AttestationConsumption.t.sol`: attestor-sign → consume → issue.
- Cross-language: anvil fixture proving viem `signTypedData` output verifies in Solidity; `apps/attestor` unit tests for report building/epoch alignment.
- Indexer: `e2e.anvil.test.ts` — consumption recorded; **zero trades ⇒ zero `PriceConsumed`** (no idle publication); `GpuOracleState` rows correct.
- Invariant suite: no path prices anything without a report; epoch binding monotonic.

## 15. PR sequence

1. **PR1 contracts:** `GpuOracle` + `IGpuOracle` + report codec + unit tests (no wiring).
2. **PR2 contracts:** `GPUIssuance` report-based pricing (issue/issueCredited/quote*/sqrt helpers) + tests.
3. **PR3 contracts:** `GPUHook` fail-closed + transient same-price plumbing; `GpuRouter`/`GpuQuoter` updateData pass-through — the invariant PR; full hook/router/E2E test updates.
4. **PR4 TS:** `packages/attestor-client` codec + signing module; cross-verify fixtures vs PR1.
5. **PR5 attestor:** publisher → attestor rebuild; `reports` DB migration; delete chain-write path.
6. **PR6 API:** `/v1/prices/:gpu/attestation` + tests.
7. **PR7 web:** quote/execute lifecycle, slip, reads, ABIs, addresses.
8. **PR8 indexer:** events/schema/handlers + API proxy map.
9. **PR9 deploy:** `Deploy.s.sol` / `Deploy.full.s.sol`, deployment record, bootstrap recipe, anvil mock attestor.
10. **PR10 docs/cleanup:** PROTOCOL.md §11 rewrite, deploy docs; delete `GPUPriceOracle` / `MockGPUPriceOracle` / `apps/publisher`.

## 16. File map

| Area | Files |
|---|---|
| New | `src/oracle/GpuOracle.sol`, `src/oracle/IGpuOracle.sol`; `packages/attestor-client`; `apps/attestor/*` (from `apps/publisher`); `packages/db` reports migration |
| Rewritten | `GPUIssuance.sol` (:161,:202,:236,:257,:278,:295,:333), `GPUHook.sol` (:54,:82,:92,:237,:257,:601,:881,:918), `GpuRouter.sol` (:84,:94,:127,:153,:181,:217,:256,:275,:305,:337), `GpuQuoter.sol` (:112-:131,:281-:291) |
| Deleted | `GPUPriceOracle.sol`, `IGPUPriceOracle.sol`, `MockGPUPriceOracle.sol`, `apps/publisher/*` |
| API | `server.ts` (new route), `protocol/routes.ts`, `protocol/sql.ts` |
| Web | `trading/quotes.ts`, `trading/hook-quote.ts`, `trading/onchain-trading-port.ts`, `action-runner.ts`, `order-slip.tsx`, `reads.ts`, `contracts.ts`, `abis/*` (regen), `addresses.generated.ts` (regen) |
| Indexer | `scripts/generate-config.ts`, `schema.graphql`, `src/handlers/oracle.ts`, `abis/oracle.json` |
| Deploy | `Deploy.s.sol`, `Deploy.full.s.sol`, `deployments/<chainId>.json` (regen) |
| Tests | new `GpuOracle.t.sol`; updated `GPUHook.t.sol`, `GPUIssuance.t.sol`, `GpuRouter.t.sol`, `E2E.t.sol`, `OraclePublication.t.sol` → `AttestationConsumption.t.sol`; web/indexer anvil suites |

## 17. Decisions needing approval

1. **`EPOCH_LENGTH` = 60s** (owner-tunable) — tighter freshness vs. higher expired-tx retry rate. Recommended: 60s.
2. **Strict current-epoch acceptance + first-consumed reportHash binding** (recommended) vs. a grace window over the previous epoch (rejected: reintroduces adversarial selection).
3. **Mainnet migration posture:** clean redeploy recommended. What happens to existing Robinhood pools/old oracle/publisher — keep old stack live until volume migrates, or freeze immediately? Old POL principal is exit-only via trading.
4. **Per-epoch SSTORE observability** in `GpuOracle` (recommended, ~20k once/epoch/gpu) vs. zero-storage verifier + event-only indexing.
5. **Single attestor signer V1** + 2-step rotation (matches today's trust model) vs. threshold/quorum from day one.
6. **`reportHash` = keccak(abi.encode(Report, signature))** (recommended — binds signer) vs. typed-digest hash.
7. **`updateData` inside `BuyParams`/`SellParams`** (recommended — one struct) vs. trailing calldata arg on every router function.
8. **`PriceConsumed` emitted by first consumer only** (recommended) vs. every consumption.
9. **Attestor cadence:** one report per epoch per GPU, re-attesting the latest healthy candidate within the 300s observation floor — confirm acceptable.
