# gUSD Index Methodology — v0.2.0 (seven panels, per-panel quorums)

The index is a weighted mean of capped weights over per-provider medians,
guarded by screens and gates, published only when every gate passes. This
document specifies v0.2.0 exactly as configured in
`packages/pricing-engine/src/config.ts` (`DEFAULT_METHODOLOGY_CONFIG`) and
validated by an exhaustive allowlist — thresholds live in config, never in
code, and a methodology change is a **new version row**, never a mutation.

v0.2.0 extends v0.1.0's single methodology with **per-panel overrides**: the
four flagship order-book panels keep the conservative v0.1.0 quorum, while the
thin SKUs of the PROTOCOL.md §3 universe (A100, B300, GB200, GB300) settle
over named rate-card principals under relaxed, per-panel gates — capped at
`degraded` so a thin panel can never look as confident as a deep one.

## Design principles

1. **Raw data is immutable.** Observations are append-only; every derived row
   carries the inputs that produced it.
2. **One economic contribution per provider.** A provider with one GPU or
   forty SKUs casts exactly one vote per window.
3. **Collection breadth ≠ settlement eligibility.** Many providers are
   collected for coverage; globally only four are settlement-eligible, and
   the engine filters by role itself — watchdog feeds are structurally unable
   to influence settlement. v0.2.0 adds one narrow exception: a methodology
   override may promote a named `COLLECTED` **principal** to settlement
   eligibility *for one panel only* (`panelOverrides.additionalProviders`).
   Promotions may only relax gates; only `COLLECTED` providers can be
   promoted, so watchdog and excluded providers can never leak in.
4. **Missing data is not zero; empty is not "no capacity".** Held-out
   providers are recorded (`thin_book_holdout`, price null), never silently
   absent.
5. **Never interpolate.** A stale index carries forward the prior value with
   an explicit `stale` flag and a link to the prior candidate — or withholds.
6. **Withheld is safer than fabricated.** Every gate failure publishes
   `withheld` with the failed gate recorded, not a fallback number.
7. **A parser change must fail loudly.** Zero parsed rows from an HTTP 200 is
   a failure, not an empty success.

## Configuration (v0.2.0)

```jsonc
{
  "version": "0.2.0",
  "screening": {
    "minProvidersForScreen": 4,   // MAD screen needs ≥4 contributions
    "madScale": 1.4826,           // MAD → σ-consistent scale
    "sigmaLimit": 3,              // |v − median| > 3σ ⇒ excluded
    "madZeroRatioBand": 3         // MAD = 0 ⇒ keep within 3× median ratio
  },
  "aggregation": {
    "minMachinesForBook": 5,      // depth floor: distinct machines
    "minHostsForBook": 3,         // depth floor: distinct hosts
    "arithmeticTolerancePerGpu": 0.005,
    "gpuCountMin": 1, "gpuCountMax": 16,   // never defaulted, never guessed
    "eligibleTiers": ["on_demand"]
  },
  "weights": { "executable": 1.0, "rateCard": 0.6 },
  "weightCap": 0.35,
  "dispersion": { "max": 0.45, "warn": 0.25 },
  "confidence": { "voteSigmaFloor": 0.03 },
  "gates": {
    "minProviders": 4,
    "minObservations": 3,
    "maxObservationAgeMs": 1_800_000,   // 30 min
    "requireExecutable": true
  },
  "stale": { "carryForwardWindowMs": 86_400_000 },   // 24 h
  "jump": { "maxProviderJumpPct": 0.25, "minCorroborators": 2,
            "minCorroboratorMovePct": 0.10 },
  // v0.2.0: per-panel patches. Only relaxations validate; unknown panel ids
  // and empty patches are rejected.
  "panelOverrides": {
    "A100_PANEL_V1": { "additionalProviders": ["datacrunch", "lambda", "coreweave", "crusoe"],
                       "gates": { "minProviders": 3, "requireExecutable": false } },
    "B300_PANEL_V1": { "additionalProviders": ["datacrunch", "nebius", "scaleway"],
                       "gates": { "minProviders": 2, "requireExecutable": false } },
    "GB200_PANEL_V1": { "additionalProviders": ["oracle-oci"],
                        "gates": { "minProviders": 1, "minObservations": 1,
                                   "requireExecutable": false } },
    "GB300_PANEL_V1": { "additionalProviders": ["datacrunch", "oracle-oci"],
                        "gates": { "minProviders": 2, "requireExecutable": false },
                        "dispersion": { "max": 0.9 } }
  }
}
```
4. **Missing data is not zero; empty is not "no capacity".** Held-out
   providers are recorded (`thin_book_holdout`, price null), never silently
   absent.
5. **Never interpolate.** A stale index carries forward the prior value with
   an explicit `stale` flag and a link to the prior candidate — or withholds.
6. **Withheld is safer than fabricated.** Every gate failure publishes
   `withheld` with the failed gate recorded, not a fallback number.
7. **A parser change must fail loudly.** Zero parsed rows from an HTTP 200 is
   a failure, not an empty success.

## Configuration (v0.1.0)

```jsonc
{
  "version": "0.1.0",
  "screening": {
    "minProvidersForScreen": 4,   // MAD screen needs ≥4 contributions
    "madScale": 1.4826,           // MAD → σ-consistent scale
    "sigmaLimit": 3,              // |v − median| > 3σ ⇒ excluded
    "madZeroRatioBand": 3         // MAD = 0 ⇒ keep within 3× median ratio
  },
  "aggregation": {
    "minMachinesForBook": 5,      // depth floor: distinct machines
    "minHostsForBook": 3,         // depth floor: distinct hosts
    "arithmeticTolerancePerGpu": 0.005,
    "gpuCountMin": 1, "gpuCountMax": 16,   // never defaulted, never guessed
    "eligibleTiers": ["on_demand"]
  },
  "weights": { "executable": 1.0, "rateCard": 0.6 },
  "weightCap": 0.35,
  "dispersion": { "max": 0.45, "warn": 0.25 },
  "confidence": { "voteSigmaFloor": 0.03 },
  "gates": {
    "minProviders": 4,
    "minObservations": 3,
    "maxObservationAgeMs": 1_800_000,   // 30 min
    "requireExecutable": true
  },
  "stale": { "carryForwardWindowMs": 86_400_000 },   // 24 h
  "jump": { "maxProviderJumpPct": 0.25, "minCorroborators": 2,
            "minCorroboratorMovePct": 0.10 }
}
```

## Stage 1 — per-provider aggregation (`aggregateProviderPrice`)

Pure; one call per provider per window, including providers with zero window
observations (they surface as holdouts with `price: null` and are recorded,
never skipped).

**Order-book path** (machine/host identifiers present):

- Skip bid-priced offers (`is_bid`).
- `gpuCount ∉ 1..16` → excluded (`invalid_gpu_count`) — an instance price is
  never divided by a guessed count.
- **Arithmetic tripwire**: `|round(perGpu, 4)·n − dph_total| ≤ 0.005·n` —
  catches instance-price-as-per-GPU at collection time.
- Dedup by machineId ?? hostId ?? offerId, keeping the cheapest per-GPU offer
  per machine — duplicates don't deepen the book.
- **Depth floors**: ≥5 machines and ≥3 hosts, else `thin_book_holdout`
  (price null, method recorded). Book truncation (`coverageGap`) is flagged.
- **Volume-weighted median**, weight = gpuCount capped at 16.
- Per-SKU plausible-band check (from `@gusd/gpu-catalog`) — outside the band
  ⇒ `out_of_band`, excluded.

**Rate-card path** (no machine identity): tier filter (default on-demand
only) → median. Plausible-band check applies equally.

## Stage 2 — index computation (`computeIndex`)

0. **Effective config** (v0.2.0): the runner merges the panel's
   `panelOverrides` patch over the global methodology
   (`effectiveConfigFor(config, panelId)` — identity when no patch applies)
   and computes against the result. The receipt records the **effective**
   config, so every candidate is replayable from its own bytes. Overrides may
   only relax: unknown panel ids, empty patches, and tightening patches
   (e.g. a dispersion `warn ≥ max`) fail validation.
1. Filter to settlement-eligible providers with non-null prices
   (`providersObserved`) — global `SETTLEMENT_ELIGIBLE` role, plus any
   `COLLECTED` principal named in this panel's `additionalProviders`.
2. **Jump screen** (per provider, vs its own trailing median from
   `provider_prices` history): a move ≥25% with fewer than 2 corroborators
   moving ≥10% excludes the mover for this computation. Starvation guard: the
   screen is skipped when fewer than `minCorroborators + 1` comparable
   providers exist.
3. **MAD screen** (≥4 kept providers): exclude |v − median| > 3·1.4826·MAD.
   When MAD = 0 (exact consensus — including manufactured consensus), keep
   only values within a symmetric 3× ratio band around the median. The
   motivating failure: four providers at $3.00 and one at $1M previously
   published a garbage price because σ-z-scoring degenerates at MAD = 0.
4. **Weights**: `executable` flag (an order book that met the depth floors)
   → 1.0; rate card → 0.6. Iterative cap: no provider may carry >35% of total
   weight (`w_i = cap·others/(1−cap)`, ≤20 iterations, deterministic order).
5. **Price**: weighted mean of kept contributions, rounded to 4 decimals.
6. **Dispersion**: 1.4826·MAD(kept)/median(kept) — scale-free.
7. **Confidence band**: per-provider votes at p±σ (σ = max(trailing σ, 3%
   floor)), band = max(p − q25, q75 − p) of the vote distribution.
8. **Gates** (all must pass, evaluated against the panel's effective config):
   - `min_providers`: contributors ≥ 4 (per-panel override may lower this —
     3 for A100, 2 for B300/GB300, 1 for GB200)
   - `min_observations`: Σ contributor sampleSize ≥ 3
   - `freshness`: every contributor has a known last-observation time within
     30 minutes
   - `require_executable`: ≥1 executable contributor (absent for the four
     thin panels, whose named principals are rate cards)
   - `max_dispersion`: ≤ 0.45 (0.9 for GB300 while its market is two prices
     2× apart)

   Any failure ⇒ **`withheld`**: the computed price is stored with the failed
   gate list, but nothing is published.
9. **Status**:
   - gates pass, dispersion ≤ 0.25, contributors ≥ the **global** quorum of
     4 → `healthy`
   - gates pass but dispersion > 0.25, **or the panel passed its relaxed
     per-panel quorum while contributing fewer than the global 4** →
     `degraded` (the v0.2.0 sub-quorum honesty ceiling: a thin panel may
     publish, but never at full confidence)
   - no kept contributors + fresh prior ≤ 24h → `stale` (carry-forward:
     prior price, `prior_candidate_id` link, flagged — never presented as
     fresh)
   - no kept contributors, no fresh prior → `withheld`

## Currency and units

All observations normalize to **USD per GPU-hour**. Non-USD rows use ECB
reference rates (`fx_rates`, first-write-wins per (currency, date), never
rewritten); a missing or >7-day-stale rate parks the observation — a rate is
never guessed. Unit conversions are pure and fixture-tested (per-second,
per-minute, 1e-8/minute, cents, monthly ÷ 730). A null gpuCount on an
instance-unit price is `insufficient_data`, never defaulted.

## Determinism, receipts, audit

Every candidate embeds a **receipt**: canonical JSON over the methodology
config, gates with verdicts, per-provider contributions (price, weight before
and after cap, sampleSize, method, trailing σ), exclusions with reasons,
providers observed/contributing, window bounds. `calc_hash` = sha256 of the
receipt; a byte-identical recomputation is the same fact (unique index), so
replays converge instead of accumulating rows.

Trailing provider stats (σ and median baseline for the jump screen) derive
from the provider's own `provider_prices` history. A constant history yields
σ = 0 by definition — the implementation guards against float-cancellation
noise (~1e-16) that would otherwise churn receipt bytes and prevent an
unchanged market from ever converging.

**Verification**: `pnpm replay:verify` recomputes each panel's latest
candidate through the identical assembly path and byte-compares the receipt
hash. Nine fast-check properties hold for the engine: containment in the
contributor range; absurd values always screened; flooding invariance; scale
invariance; order irrelevance; weight cap holds; failed gate blocks
publication; dispersion ≥ 0; screening monotone in its own criterion.

## Known limitations (documented, not fixed, in v0.2.0)

- **Gate flicker**: a market sitting on a threshold can flip healthy ↔
  withheld between computations. Hysteresis is planned future work.
- **Fixed weights**: executable 1.0 / rate-card 0.6 is a judgement, not a
  measured reliability score. Liveness/predictive weighting is documented as
  future work, deliberately not implemented.
- **Administered pricing**: spot = exactly 2.000× on-demand patterns are
  detectable (CV ≈ 0.0001) but not yet auto-excluded; they are visible in
  receipts.
- **Windowed view cannot reconstruct per-run book truncation** (`coverageGap`
  is a collection-time flag); the windowed aggregation defaults it to false —
  documented, accepted for v0.1.0.
