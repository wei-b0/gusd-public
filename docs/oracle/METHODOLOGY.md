# gUSD Index Methodology — v0.4.0 (four panels, per-panel quorums)

The index is a weighted mean of capped weights over per-provider medians,
guarded by screens and gates, published only when every gate passes. This
document specifies v0.4.0 exactly as configured in
`packages/pricing-engine/src/config.ts` (`DEFAULT_METHODOLOGY_CONFIG`) and
validated by an exhaustive allowlist — thresholds live in config, never in
code, and a methodology change is a **new version row**, never a mutation.

The settlement universe is the launch four: `H100_PANEL_V1`
(`H100_SXM_80GB`), `H200_PANEL_V1` (`H200_141GB`), `L40S_PANEL_V1`
(`L40S_48GB`) and `RTX_4090_PANEL_V1` (`RTX_4090_24GB`). The broader
`@gusd/gpu-catalog` `CATALOG` (27 SKUs) is collection-only — old panels keep
their historical rows, but nothing outside the four settles or publishes.

## Version history

- **v0.1.0** — the base methodology: quorum 4, executable contributor
  required, no overrides. Identical to the v0.4.0 block below minus
  `panelOverrides` and `movement`.
- **v0.2.0** — added `panelOverrides` so the seven-SKU paper universe could
  settle: A100/B300/GB200/GB300 ran on relaxed quorums over named rate-card
  principals, capped at `degraded`.
- **v0.3.0** — added the publishing movement allowance so rate-card-settled
  panels print a moving series (see [Movement allowance](#movement-allowance)).
- **v0.4.0** — the settlement universe is cut to the launch four. The
  A100/B300/GB200/GB300 overrides are deleted; those GPUs return to
  collection-only. Two thin panels keep overrides: L40S settles over
  DataCrunch/Scaleway/CoreWeave at quorum 3 with no executable floor
  (temporary — revert once executable L40S books deepen); RTX 4090 promotes
  Akash alongside Vast + RunPod at quorum 3 with the executable floor kept.
  H100/H200 settle under the untouched global methodology.

## Design principles

1. **Raw data is immutable.** Observations are append-only; every derived row
   carries the inputs that produced it.
2. **One economic contribution per provider.** A provider with one GPU or
   forty SKUs casts exactly one vote per window.
3. **Collection breadth ≠ settlement eligibility.** Many providers are
   collected for coverage; globally only four are settlement-eligible, and
   the engine filters by role itself — watchdog feeds are structurally unable
   to influence settlement. One narrow exception: a methodology override may
   promote a named `COLLECTED` **principal** to settlement eligibility *for
   one panel only* (`panelOverrides.additionalProviders`). Promotions may
   only relax gates; only `COLLECTED` providers can be promoted, so watchdog
   and excluded providers can never leak in.
4. **Missing data is not zero; empty is not "no capacity".** Held-out
   providers are recorded (`thin_book_holdout`, price null), never silently
   absent.
5. **Never interpolate.** A stale index carries forward the prior value with
   an explicit `stale` flag and a link to the prior candidate — or withholds.
6. **Withheld is safer than fabricated.** Every gate failure publishes
   `withheld` with the failed gate recorded, not a fallback number.
7. **A parser change must fail loudly.** Zero parsed rows from an HTTP 200 is
   a failure, not an empty success.

## Configuration (v0.4.0)

```jsonc
{
  "version": "0.4.0",
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
  // v0.3.0: the publishing movement allowance — ±0.05% around the anchor.
  "movement": { "allowancePct": 0.0005, "slotMs": 30_000,
                "reversion": 0.7, "stepPct": 0.4 },
  // v0.4.0: per-panel patches for the two thin launch panels. Only
  // relaxations validate; unknown panel ids and empty patches are rejected.
  "panelOverrides": {
    "L40S_PANEL_V1":     { "additionalProviders": ["datacrunch", "scaleway", "coreweave"],
                           "gates": { "minProviders": 3, "requireExecutable": false } },
    "RTX_4090_PANEL_V1": { "additionalProviders": ["akash"],
                           "gates": { "minProviders": 3, "requireExecutable": true } }
  }
}
```

### Per-panel overrides (v0.4.0)

| Panel | Promoted principals | Gates patch | Why |
|---|---|---|---|
| `L40S_PANEL_V1` | datacrunch, scaleway, coreweave | `minProviders: 3`, `requireExecutable: false` | Vast's verified+rentable L40S book is too thin to settle alone and RunPod lists without stock; the three principals carry live L40S rate cards. **Temporary** — revert to the global gates once executable L40S order books deepen. |
| `RTX_4090_PANEL_V1` | akash | `minProviders: 3`, `requireExecutable: true` | Vast + RunPod are executable; Akash's `rtx4090` rate card completes the quorum without giving up the executable floor. |

H100 and H200 have no override: they settle under the global gates — quorum
4, executable required — exactly as v0.1.0 defined them.

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

0. **Effective config**: the runner merges the panel's `panelOverrides`
   patch over the global methodology (`effectiveConfigFor(config, panelId)`
   — identity when no patch applies) and computes against the result. The
   receipt records the **effective** config, so every candidate is replayable
   from its own bytes. Overrides may only relax: unknown panel ids, empty
   patches, and tightening patches (e.g. a dispersion `warn ≥ max`) fail
   validation.
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
     3 for L40S and RTX 4090)
   - `min_observations`: Σ contributor sampleSize ≥ 3
   - `freshness`: every contributor has a known last-observation time within
     30 minutes
   - `require_executable`: ≥1 executable contributor (dropped for L40S by
     override while its executable book is thin; kept for RTX 4090)
   - `max_dispersion`: ≤ 0.45

   Any failure ⇒ **`withheld`**: the computed price is stored with the failed
   gate list, but nothing is published.
9. **Status**:
   - gates pass, dispersion ≤ 0.25, contributors ≥ the **global** quorum of
     4 → `healthy`
   - gates pass but dispersion > 0.25, **or the panel passed its relaxed
     per-panel quorum while contributing fewer than the global 4** →
     `degraded` (the sub-quorum honesty ceiling, generalized in v0.4.0: any
     panel running under an override is capped at degraded — L40S and
     RTX 4090 both sit there today, since their quorum of 3 is below the
     global 4)
   - no kept contributors + fresh prior ≤ 24h → `stale` (carry-forward:
     prior price, `prior_candidate_id` link, flagged — never presented as
     fresh)
   - no kept contributors, no fresh prior → `withheld`

## Movement allowance

Rate-card-settled panels (L40S today) have no dynamic source — their computed
anchor is genuinely static for days, which reads as a dead tape. The
publishing movement allowance (introduced v0.3.0, carried into v0.4.0) lets
the *published* figure carry a bounded, deterministic, mean-reverting offset
around the computed anchor:

- `allowancePct: 0.0005` — the published figure never moves more than ±0.05%
  from the anchor.
- `slotMs: 30_000` — the offset's randomness reseeds at most once per 30s
  slot.
- `reversion: 0.7` — 70% of the current published-vs-anchor gap carries into
  the next slot, so the offset drifts back toward the anchor.
- `stepPct: 0.4` — each slot's step is at most 40% of the full allowance.

The anchor itself is untouched: screens, weights, dispersion, confidence band
and gates all compute on real data. The offset is confessed here, recorded
per receipt (`calcParams.movementOffset`), and every candidate remains
replayable from its own bytes. Absent `movement` section ⇒ disabled (a
stored pre-0.3.0 config validates unchanged).

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

## Known limitations (documented, not fixed, in v0.4.0)

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
  documented, accepted since v0.1.0.
- **L40S runs without an executable floor** (`requireExecutable: false`) —
  a temporary relaxation, to be reverted once executable L40S order books
  deepen. Until then the panel cannot report `healthy` even at full quorum.