# gUSD Oracle — Research Notes

Research basis for the oracle design: five prior art repositories were studied
(code, methodology, and operational behaviour) plus live endpoint sanity
checks. This document records what was learned, what was adopted, and —
equally important — what may **not** be reused.

## Licensing summary (binding)

| Repository | Licence | What we may take | What we may not take |
|---|---|---|---|
| `computable/gpu-index` | Apache-2.0 (code) / CC BY-NC 4.0 (published CGI data) / all-rights-reserved (raw observations) | Code ideas and structure with attribution | Their **published index data and raw observations** may not be used or redistributed anywhere in gUSD |
| `zacharyfrederick/compex` | MIT | Code, freely | — |
| `ygwyg/gputable` | none | Endpoints and techniques only | Any code |
| `henryzhangpku/gpu-price-index` | none | Methodology only | Any code |
| `spacesudo/gpu_price_snapshot` | none | Design only | Any code |

Additional data licences:

- **gputable.dev/data.json** — live, requires attribution. Stored beside every
  payload in `watchdog_feeds.license_note`; used **only** as a WATCHDOG feed,
  never contributes to the index.
- **computable published artifacts** — CC BY-NC 4.0. Internal comparison only;
  never redistributed, never published onward.

## computable/gpu-index — primary reference

**Collector contract.** Per-row observations carry the provider's own label
and the raw published figure beside the normalized value (`rawValue`,
`rawUnit`, `gpuCount`); canonical SKU derivation belongs to the framework,
never to collectors; rows that cannot be pinned are counted in `partialErrors`
and never guessed. Any failure raises — including "parsed zero rows from an
HTTP 200", which is treated as a layout rot signal, not an empty success.

**Failure taxonomy** `fetch | parse | timeout | budget` with per-source
deadlines and no blind retries. A *thin-capture gate* treats an interval left
unclaimed as a visible hole — no backfilling.

**SKU canonicalization** (adopted into `@gusd/gpu-catalog`): uppercase,
separator and alpha→digit boundary normalization; lookarounds
`(?<![A-Z0-9])TOKEN(?![A-Z0-9])` so `B200` never matches inside `GB200`,
`A10` inside `A100`, `H20` inside `H200`; ordered first-match-wins catalog
with variants above generics; per-SKU plausible USD/GPU-hour bands (H100
[0.2, 25], B200 [0.5, 40], RTX4090 [0.05, 5]); unmapped labels go to a
worklist with a null gpuId, never a guess.

**Vast order book handling**: q-embedded query posted bare (a `{"q": …}`
wrapper 400s), per-chip spacing, server clamp of 64 offers; ASC+DESC
dual-window merge with a `coverageGap` flag on truncation; identity pin
(offer `gpu_name` must equal the queried SKU); `num_gpus ∈ 1..16` is never
defaulted (blocks instance-price-as-per-GPU); arithmetic tripwire
`|round(perGpu, 4)·n − dph_total| ≤ 0.005·n`; bids skipped; per-machine dedup
keeps the cheapest per-GPU offer; VWM with depth floors (≥5 machines, ≥3
hosts) else `thin_book_holdout`.

**Screens**: tier allow-list; jump screen ≥25% with <2 corroborators moving
≥10%; implausible values flagged, never deleted; self-history outlier fence;
FX from ECB with first-write-wins append-only storage, 7-day staleness →
hold out (never guess a rate); currency switch requires 3 confirming prints.

**Aggregation & publication**: vote-IQM; per-observation `calc_params` +
per-source receipts (published/withheld + filter verdicts); digest over
canonical JSON; config validated by exhaustive allowlist; thresholds live in
config, not code.

## gpu-price-index — methodology (no licence; ideas only)

- **One median per provider regardless of SKU count** — one vote per provider;
  defeats flooding with many cheap listings.
- MAD×1.4826 > 3σ screen, only with ≥4 providers. **MAD = 0 → symmetric 3×
  ratio band** — their motivating regression: four providers at $3.00 plus one
  at $1M published $200,002 because MAD was 0 and σ-z-scoring broke down.
- Tier weights EXECUTABLE 1.0 / LIST_PRICE 0.6 / JUDGEMENT 0.25; iterative 35%
  weight cap.
- Gates: providers ≥4, observations ≥8, dispersion ≤0.45, share ≤35% → else
  `withheld` with the gate failure recorded. **No interpolation or
  carry-forward without an explicit flag.**
- Bitemporal audit (event time + knowledge time); fingerprint over stable
  fields excluding observedAt → stall detection; <50% provider dropout and
  >15% level shifts flag for review.
- Operational lessons: administered pricing is detectable (spot = exactly
  2.000× on-demand, CV 0.0001 — configurable exclusion); "a wrong number that
  gets screened is more dangerous than one that doesn't" — screen logs need
  review; gate flicker (withheld ↔ published an hour apart on an unmoved
  market) argues for hysteresis in a future version.
- Property invariants they test and we adopted: containment in [min, max] of
  contributors; absurd values always screened; flooding invariance; scale
  invariance; order irrelevance; cap holds; failed gate blocks publication;
  dispersion ≥ 0.

## gputable — provider catalogue (no licence; endpoints/techniques only)

- ~40 providers probed. Executable order books: Vast (POST, bare q), RunPod
  (GraphQL), Akash, Lium, PrimeIntellect (Bearer optional). Rate cards:
  Lambda, CoreWeave, Nebius (committed + on-demand columns), Crusoe,
  DataCrunch, DigitalOcean, Together, Azure OData (≤25 pages), AWS static
  pricing JSON, Oracle APEX JSON, Cudo, Scaleway (EUR→USD), OVH (1e-8/min).
- Alias table patterns: ordered first-match-wins regex with `\b` boundaries;
  PCIe before NVL ("H100 PCIe NVLink"); Ti before base; **25% VRAM deviation
  guard** — a 40GB A100 or MIG slice may not impersonate a 80GB SKU.
- Ops: `Promise.allSettled` isolation; throw on zero parsed rows; retries only
  for network/429/5xx (3 attempts, 1.5s·attempt, 25s timeout); two-tier cron;
  6h TTL for expensive sources; >24h failing provider → daily alert; gzipped
  sanitized fixture replay in CI with the contract "≥ half recorded rows,
  prices in (0, 200)"; ECB FX with 6h cache.

## compex — realtime architecture (MIT; code reusable)

- Task state machine Starting→Running→Backoff→CircuitOpen→Stopping→Stopped.
  Adopted into `@gusd/collector-kit`: backoff 2^attempt capped 64s, budget 4
  attempts; **circuit opens at 5 consecutive failures for 60s**, half-open
  probe resets; missed ticks are skipped, never queued.
- Error taxonomy driving retryable-vs-fatal at the consumer: Network,
  NoQuotes, InsufficientData, ParseError, ProviderUnavailable,
  AuthenticationFailed, RateLimited{retryAfter}, StaleData — mirrored in our
  `FailureKind`.
- Index hygiene MVP (we kept the conservative core): per-provider
  winsorize → provider median → cross-provider median; 15-min freshness; min
  2 providers; stale carry-forward 10 min; per-offer ceiling; min sample.
- Serving: REST + WS broadcast of one stable message; a lagging WS consumer
  must resync, not drop; aggregated health report (Healthy/Degraded/
  Unhealthy).
- Weaknesses we deliberately avoided: shutdown-only non-atomic persistence;
  no restart-on-crash; live system Vast-only (dead code diversity).

## gpu_price_snapshot — design only (no licence)

- RunPod single GraphQL POST yields catalog + 4 price tiers +
  `lowestPrice{uninterruptablePrice, minimumBidPrice, stockStatus}` — the
  shape of our RunPod collector.
- Vast filters `{"verified":{"eq":true},"rentable":{"eq":true},…}` and
  separate ondemand/bid queries.
- `raw_json JSONB` beside normalized columns + deterministic uniqueness +
  `ON CONFLICT DO NOTHING` → idempotent provenance; adopted as
  `raw_observations.raw_payload` + `obs_fingerprint`.

## Live endpoint sanity checks (2026-09-04)

- `https://gputable.dev/data.json` — live, fresh; rows carry
  `{gpu, vram_gb, architecture, provider, gpu_count, price_per_hour_usd,
  pricing_type, commitment_months, available, source_url}`; 41 providers.
  WATCHDOG feed only (attribution required).
- `https://console-api.akash.network/v1/gpu-prices` — live, no auth; per-model
  `{vendor, model, ram, interface, availability, providerAvailability,
  price{min,max,avg,weightedAverage,med}}`. Aggregated bid stats → one
  MEDIUM contribution.
- Live-boot behaviour (2026-09-04): several endpoints answer but with shapes
  or payloads our fixture parsers reject (see PROVIDERS.md "live status").
  The fixture parsers are the contract; live drift is recorded as
  `source_failures` (schema_drift / empty_result) and surfaces in
  `/v1/health` rather than corrupting the index.
