# gUSD Oracle — Architecture

The oracle turns GPU rental prices from many providers into manipulation-
resistant, auditable USD/GPU-hour reference prices for the gUSD stablecoin.

## The pipeline

```
providers (20)
   │  collect()          @gusd/collectors — thin I/O, PURE parsers, fixtures
   ▼
Scheduler (3 lanes)     @gusd/collector-kit — timeout, retry, circuit breaker
   │  SchedulerEvent
   ▼
IngestionService        apps/oracle — one transaction per run
   │                      raw_observations (append-only, fingerprint-deduped)
   │                      → @gusd/normalize → normalized_observations
   │                      unmapped labels → worklist
   ▼
EngineRunner (debounced per GPU)
   │  window observations → one economic contribution per provider
   │  → computeIndex (@gusd/pricing-engine, PURE) → candidate + receipt
   ▼
Postgres (append-only ×2)          EventBus
   │                                  │
   ▼                                  ▼
REST /v1/prices · WS /v1/stream · SSE        apps/publisher
GET /v1/providers · /v1/health               validate → mock target → ledger
```

**The frontend never touches upstream providers.** Everything user-facing
reads the oracle's local database or its API.

## Workspaces

| Package | Responsibility | Import boundary |
|---|---|---|
| `@gusd/types` | Enums, observation/failure types, canonicalJson, uuidv7 | — |
| `@gusd/gpu-catalog` | Canonical SKUs, deterministic label normalization, plausible bands, settlement panels | types |
| `@gusd/db` | Drizzle schema, migrations, append-only triggers, repos, migrator | types, gpu-catalog (pg/drizzle only here + apps) |
| `@gusd/collector-kit` | Collector interface, errors, hardened HTTP, lanes, scheduler, breaker | types (DB-free) |
| `@gusd/normalize` | Raw → normalized: FX (pure), units, tiers | types, gpu-catalog |
| `@gusd/pricing-engine` | PURE engine: screens, aggregation, weights, band, gates | types, gpu-catalog (no node builtins, lint-enforced) |
| `@gusd/collectors` | Per-provider collectors + PURE parsers + recorded fixtures + registry | kit, normalize, gpu-catalog |
| `apps/oracle` | main: collectors + scheduler + ingest + engine + REST/WS/SSE + replay + audit CLI | everything |
| `apps/publisher` | Independent publisher process; holds all key material (mock target for now) | db, gpu-catalog, types |

## Collection layer

**Collector interface** (from `@gusd/collector-kit`):

```ts
interface GpuCollector {
  readonly id: string; readonly providerSlug: string;
  readonly sourceType: SourceType; readonly cadenceTier: CadenceTier;
  collect(ctx: CollectContext): Promise<CollectionResult>;
}
interface CollectContext {
  now: Date; signal: AbortSignal;
  secrets: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch; logger: Logger;
}
```

Collectors do **network I/O only via the injected fetch** and never touch the
database. Parsing is pure: `parse(payload, now) → RawObservationInput[]` with
recorded, sanitized fixtures per provider. HTTP 200 + expected container
present + zero items → `errEmptyResult`; container missing or field
validation failing → `errSchemaDrift`. Zero parsed rows is always a failure.

**Scheduler.** Three lanes (FAST 10–30s, MEDIUM 30–120s, SLOW 5–15min) with
separate worker pools — a hung collector can never block another lane. Per-run
`Promise.race` timeout with AbortSignal + reaper; 8MB response cap;
https-only redirect refusal. Retry: 2^attempt·1s capped 64s, budget 4. Circuit
breaker: ≥5 consecutive failures → open 60s → half-open probe. `rate_limited`
honours `retryAfter`. Jitter is seeded per collector+minute (replayable).
Restart: next due times rebuilt from `collection_runs`; the breaker streak
rehydrates from `source_failures`; fingerprint dedup makes re-runs idempotent.

**Non-GPU feeds** (FX + 2 watchdogs) run on their own loop in `FeedRunner` —
they are structurally unable to produce observations and never touch the
scheduler.

## Storage

Postgres 16, Drizzle ORM. All timestamps timestamptz; prices numeric; uuidv7
primary keys. Append-only tables: `raw_observations`,
`normalized_observations`, `provider_prices`, `index_candidates`,
`published_index_values`, `publish_violations`, `source_failures` — enforced
twice: `BEFORE UPDATE OR DELETE OR TRUNCATE` triggers raising an exception
(`gusd_forbid_mutation`), plus (in production) an app role granted
INSERT/SELECT only. Cleanup means drop-and-recreate the schema, by design.

Key integrity devices:

- `raw_observations.obs_fingerprint` = sha256(provider, sourceId, observedAt,
  label, unit, region, gpuCount) — `ON CONFLICT DO NOTHING` makes every
  collection restart-idempotent. The fingerprint deliberately **excludes the
  raw price**: a corrected re-ingest of the same identity dedups rather than
  duplicating.
- `index_candidates.calc_hash` = sha256(canonicalJson(receipt)); unique
  `(gpu_id, calc_hash) WHERE status <> 'stale'` — a byte-identical
  recomputation is the same fact, not a new one.
- `published_index_values` unique `(candidate_id, target)` — the publisher can
  crash after the target acknowledges; the retry is a no-op read.
- `publish_violations` unique `(candidate_id, target)` — a rejected candidate
  stays rejected.
- `fx_rates` unique `(currency, rate_date)` first-write-wins — a rate is
  never rewritten, corrections are new rows.
- `unmapped_labels` batches collapse to one row per (provider, label):
  Postgres refuses an `ON CONFLICT DO UPDATE` touching the same row twice in
  one statement, so a provider returning dozens of offers of the same unknown
  label advances `occurrences` by one (per collection, flood-invariant) —
  a duplicate-label batch must never roll back the run's raw observations.
- `methodology_versions`: insert-once, exactly one current row (partial
  unique `WHERE effective_to IS NULL`). A methodology change is a new version,
  never a mutation.

## Index engine

`computeIndex` (pure; clock and config injected) per settlement panel
(H100_PANEL_V1, H200_PANEL_V1, B200_PANEL_V1):

1. Filter provider prices to `SETTLEMENT_ELIGIBLE` with non-null price.
2. **Jump screen** vs the provider's own trailing median: ≥25% with <2
   corroborators moving ≥10% → excluded this computation.
3. **MAD screen** (≥4 providers): |v − median| > 3·1.4826·MAD → excluded;
   MAD = 0 → symmetric 3× ratio band.
4. Weights by the explicit `executable` flag (1.0 order book meeting depth
   floors, 0.6 rate card), iterative 35% weight cap.
5. Weighted mean → price (4dp); dispersion = 1.4826·MAD(kept)/median(kept).
6. Confidence band from p±σ votes, per-provider σ floored at 3%.
7. **Gates** — minProviders 4, minObservations 3, maxObservationAge 30min,
   requireExecutable ≥1, maxDispersion 0.45 → failure ⇒ `withheld` (price is
   stored for audit, gated from publication). dispersion > 0.25 ⇒ `degraded`.
   No kept providers + fresh prior (≤24h) ⇒ `stale` (carry-forward, flagged,
   linked via prior_candidate_id); else `withheld`.

The receipt is canonical JSON over everything that determined the output —
config, gates, per-provider contributions with σ, exclusions, window. The
runner's assembly (methodology load, windowed observations, per-provider
aggregation, trailing stats) is shared verbatim with the replay-compare CLI
(`computeFromWindow`), so the audit tool replays the identical code path.

**Trailing stats detail** (a bug class worth recording): σ is computed from the
provider's own recent prices. A constant history must yield σ = 0 *by
definition* — computing it through the mean lets float cancellation produce
~1e-16 noise that churns receipt bytes, so an unchanged market would never
converge to a stable candidate. The constant-history guard is load-bearing.

## Serving

- `GET /v1/prices` — latest candidate per panel (withheld included as status).
- `GET /v1/prices/:gpu` — panel id or gpu id; 404 with an explanatory error
  for non-panel gpus.
- `GET /v1/prices/:gpu/history?limit=` — newest-first, clamped to 500.
- `GET /v1/providers` — the seeded registry (role, tier, source type).
- `GET /v1/health` — db ping + per-collector health (breaker state, last
  success/failure); 503 when the database is down.
- `WS /v1/stream` and `GET /v1/stream/sse` — candidate broadcasts.

## Publisher (separate process)

Polls (5s) the latest candidate per panel, re-derives its own verdict —
status ∈ {healthy, degraded}, freshness ≤5min, methodology pinned, ≥3
contributors, dispersion cap, band-width cap, jump ≤25% vs last published
(`jump_requires_manual`), and contributor source health from the oracle's
`/v1/health` (majority breaker-open ⇒ reject; oracle unreachable ⇒ refuse the
cycle). Publishes through a `PublisherTarget`; the (candidateId, target)
unique key makes publication idempotent. Rejections are recorded in
`publish_violations`. No key material outside this process.

Two targets, selected fail-closed by `PUBLISHER_TARGET`:

- `mock` (default) — deterministic sha256 txRef, for tests and dry runs.
- `chain` — signs and submits `GPUPriceOracle.publish(gpuId, price, updatedAt)`
  via viem; txRef is the tx hash and the target waits for one receipt before
  the ledger row is written. Startup `verify()` aborts boot on a chain-id,
  `PRICE_SCALE`, or publisher-identity mismatch (a wrong publisher identity
  would make every publish revert). Encoding is the wire contract pinned in
  `IGPUPriceOracle`'s NatSpec: bytes32 left-aligned ASCII SKU, price × 10_000
  (4-decimal, float-safe: 2.5001 → 25001), `updatedAt` = candidate
  `computedAt` clamped to now. The publisher key must be scoped to the
  publish role only — never owner/deployer on a live chain. Switching targets
  resets the 25% jump-gate baseline (it is per-target), so the first `chain`
  publish bypasses the jump check; the oracle's optional onchain deviation
  bound (default disabled) is the defense-in-depth backstop.

## Failure handling summary

| Threat | Defence |
|---|---|
| Provider manipulation / flooding | One contribution per provider, cheapest-per-machine dedup, arithmetic tripwire, 35% cap, MAD screen, 3× band when MAD=0 |
| Schema drift / silently-wrong data | PURE fixture-backed parsers, EmptyResult vs SchemaDrift, zero-rows-is-failure, breaker + `source_failures`, unmapped worklist |
| Hung collectors | Lane isolation, hard timeout + abort + reaper, circuit breaker |
| Missing data | Missing data is not zero; FX missing parks the observation; withheld is a valid published status |
| Audit gaps | Append-only ×2, receipts + calcHash, replay-compare CLI, violations ledger |
| Publisher oracle outage | Publisher refuses the cycle rather than publishing unvalidated |

## Replay & audit

- `pnpm replay` — offline pass: all 18 collectors + FX + watchdogs through
  recorded fixtures (`apps/oracle/replay-fixtures/`) with the clock pinned to
  `ORACLE_REPLAY_NOW`; deterministic, no network.
- `pnpm replay:verify` — recompute each panel's latest candidate through
  `computeFromWindow` and byte-compare the receipt hash against the stored
  `calcHash`. CI runs it on a frozen database, where it is exact.
- The e2e suite (`RUN_DB_TESTS=1 pnpm --filter @gusd/oracle test`) proves
  ingest idempotency: repeated replay passes converge to frozen row counts and
  add zero new candidates or observations.
