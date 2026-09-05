# gUSD Providers — Collection Matrix

20 providers + ECB FX + 2 watchdog feeds. The registry of record is
`packages/collectors/src/registry.ts` (`PROVIDER_SEEDS`); this document adds
the why and the live status. Roles: `SETTLEMENT_ELIGIBLE` (contributes to the
index), `COLLECTED` (stored for coverage, zero settlement weight),
`WATCHDOG_ONLY` (comparison feeds only — structurally excluded from the
index), `EXCLUDED`.

## Settlement panels (v0.2.0 — full PROTOCOL.md §3 universe)

| Panel | GPU id | Eligible providers | Per-panel quorum (v0.2.0) |
|---|---|---|---|
| A100_PANEL_V1 | A100_SXM_80GB | vast, lium, hyperbolic, runpod + datacrunch, lambda, coreweave, crusoe (panel-only) | 3, executable floor lifted |
| H100_PANEL_V1 | H100_SXM_80GB | vast, lium, hyperbolic, runpod | global (4) |
| H200_PANEL_V1 | H200_141GB | vast, lium, hyperbolic, runpod | global (4) |
| B200_PANEL_V1 | B200_192GB | vast, lium, hyperbolic, runpod | global (4) |
| B300_PANEL_V1 | B300_288GB | vast, lium, hyperbolic, runpod + datacrunch, nebius, scaleway (panel-only) | 2, executable floor lifted |
| GB200_PANEL_V1 | GB200_192GB | vast, lium, hyperbolic, runpod + oracle-oci (panel-only) | 1, executable floor lifted |
| GB300_PANEL_V1 | GB300_288GB | vast, lium, hyperbolic, runpod + datacrunch, oracle-oci (panel-only) | 2, executable floor lifted |

The flagship SXM panels keep the full executable quorum (order-book makers
vast/lium/hyperbolic are the only `executable` contributors). A100/B300 have
no executable market left — no order-book maker quotes them and Lium's B300
book runs thin — so their overrides promote named rate-card principals and
lift the executable floor; GB200/GB300 are pre-production and settle on a
minimal quorum of list prices. Any panel contributing fewer than the global
quorum of 4 is capped at `degraded` by the engine, never `healthy`.

Membership changes are config-only (never code): `additionalProviders` in
`panelOverrides` promotes a `COLLECTED` principal for one panel without
touching its global role, and the engine reads roles from the `providers`
table at computation time. Watchdog and excluded providers can never be
promoted.

## FAST tier (10–30s cadence)

| slug | Source | Type | Role | Endpoint | Auth |
|---|---|---|---|---|---|
| `vast` | Vast.ai | marketplace | SETTLEMENT_ELIGIBLE | POST `console.vast.ai/api/v0/bundles/` — q posted **bare** (a `{"q":…}` wrapper 400s), batched per-SKU, ASC+DESC pair for truncation detection, 64-offer server clamp. Live `gpu_name` (2026-09): `H100 SXM`, `H200`, `B200` — legacy dotted spellings kept in the alias list | none |
| `lium` | Lium | marketplace | SETTLEMENT_ELIGIBLE | GET `lium.io/api/executors` — 2026-09 contract: bare array of `{id, machine_name, price_per_gpu (USD/GPU-hr), gpu_count, available_gpu_count, executor_ip_address, tier, location}`; `costPerHr` is gone; `price_per_gpu` is priced directly; executors sharing an IP count as one host (dedup + depth floors) | none |
| `hyperbolic` | Hyperbolic | principal | SETTLEMENT_ELIGIBLE | GET `api.hyperbolic.ai/v2/alpha/on-demand/rental-options` — 2026-09 contract: bare JSON array, camelCase `{enabled, costPerHourCents (instance total), region, gpuCount, gpuType, gpuFormFactor, totalAvailable?, nodes[]}`; label = `gpuType` + `gpuFormFactor` (`h100 sxm5` → catalog `H100 SXM 5`); availability tri-state from `enabled`/`totalAvailable` | optional key |

Vast collector invariants: identity pin (offer `gpu_name` == queried SKU),
**whole-GPU rule** — `gpu_frac` is machine-share, not GPU-share, so an offer
with full stated `gpu_ram` is kept regardless of `gpu_frac`; offers with
`gpu_ram` below 75% of the catalog VRAM (MIG slices) are skipped, and when
VRAM is unverifiable the machine-share fraction acts as the conservative
proxy — `dph_total` required, arithmetic tripwire, per-machine dedup,
`num_gpus ∈ 1..16` never defaulted.

## MEDIUM tier (30–120s)

| slug | Source | Type | Role | Endpoint | Auth |
|---|---|---|---|---|---|
| `runpod` | RunPod | marketplace | SETTLEMENT_ELIGIBLE | POST `api.runpod.io/graphql` `gpuTypes` (4 tiers + `lowestPrice{uninterruptablePrice, minimumBidPrice, stockStatus}`). 2026-09: `stockStatus` became a stock **level** — `Low`/`Medium`/`High` all mean rentable; only `out_of_stock` is out, unrecognized values stay unknown (tri-state) | none |
| `shadeform` | Shadeform | aggregator | COLLECTED | GET `api.shadeform.ai/v1/instances/types` (per-cloud attribution) | none |
| `akash` | Akash | marketplace | COLLECTED | GET `console-api.akash.network/v1/gpu-prices` (aggregated bid stats) | none |
| `primeintellect` | Prime Intellect | aggregator | COLLECTED | GET `api.primeintellect.ai/api/v1/availability/gpus` — paginated (`page_size=100` server cap, walked to `totalCount`), `{items[], totalCount}`; prices split by security (`onDemand` secure vs `communityPrice` community) | **Bearer required** (free key, dashboard Settings → API Keys, `Availability -> Read`) |
| `datacrunch` | DataCrunch | principal | COLLECTED | GET `api.datacrunch.io/v1/instance-types` (on-demand + spot) | none |
| `cudo` | Cudo | marketplace | COLLECTED | GET `rest.compute.cudo.org/v1/vms/machine-types` | none |

## SLOW tier (5–15min)

| slug | Source | Type | Role | Endpoint | Notes |
|---|---|---|---|---|---|
| `azure` | Microsoft Azure | principal | COLLECTED | `prices.azure.com` OData, paginated (≤25 pages), per-SKU median sanity filter kills placeholder prices. `armRegionName` compares **verbatim** — `ORACLE_AZURE_REGION` must be a valid arm name (`eastus`, `westus2`, `westeurope`…); `us-east` matches nothing and starves the run | none |
| `aws` | AWS EC2 | principal | COLLECTED | static pricing `region_index.json` → region file. 2026-09: the per-region key renamed `currentRegionUrl` → `currentVersionUrl` (value pins the offer version path); per-region file is ~480MB (collector budget 600MB) and the collector declares its own run budget (`runTimeoutMs` 8min, region download deadline 7min) — the 60s SLOW lane default killed every live attempt. `priceDimensions[].pricePerUnit` is a **currency map** (`{"USD": "55.04"}`); only the USD entry is read. Capacity-block SKUs (`RunInstances:CB`) carry terms with no positive hourly figure and count as without-terms | none |
| `lambda` | Lambda | principal | COLLECTED | `lambda.ai/instances` HTML | none |
| `coreweave` | CoreWeave | principal | COLLECTED | `coreweave.com/pricing` HTML | none |
| `nebius` | Nebius | principal | COLLECTED | `nebius.com/prices` — embedded `__NEXT_DATA__` JSON preferred over HTML | none |
| `crusoe` | Crusoe | principal | COLLECTED | `www.crusoe.ai/cloud/pricing` HTML — canonical www host pinned (the apex 301s there and hardened fetch refuses redirects by design) | none |
| `scaleway` | Scaleway | principal | COLLECTED | Scaleway instance catalog API (EUR → USD). 2026-09: GPU flavors left fr-par-1 — H100 PCIe/L4/L40S in `pl-waw-2`, B300 SXM in `fr-par-2`; the collector walks every GPU-bearing zone (`ORACLE_SCALEWAY_ZONE` = comma-separated list) | none |
| `ovh` | OVHcloud | principal | COLLECTED | OVH public catalog (price is 1e-8/minute × 60; EUR → USD) | none |
| `oracle-oci` | Oracle Cloud | principal | COLLECTED | 2026-09: cetools APEX host is WAF-gone; the published list is joined from two sources — `oracle.com/cloud/price-list/` HTML (GPU shape rows with `data-partnumber`; canonical path, `/cloud/compute/pricing/` 301s there and hardened fetch refuses redirects) + static `oracle.com/a/ocom/docs/pricing/cloud-price-list.json` (`items[partNumber][currency]`). Page footnote pins the unit: published figure is **per GPU-hour** (server price = GPU price × GPU count) | none |

## Feeds outside the scheduler

| slug | Role | Endpoint | Notes |
|---|---|---|---|
| `ecb-fx` | — | `eurofxref` XML | Daily reference rates; `fx_rates` first-write-wins per (currency, date); a stale or missing rate **parks** non-USD observations — never guessed |
| `gputable` | WATCHDOG_ONLY | GET `gputable.dev/data.json` | **Attribution required** — terms stored beside every payload (`watchdog_feeds.license_note`). 41 providers live. Used only to compare against our candidates (`watchdog_comparisons`); deviation is recorded, never published |
| `computable` | WATCHDOG_ONLY | computable CGI published artifacts | **CC BY-NC 4.0 — internal comparison only, never redistributed.** Their code is Apache-2.0 (reusable with attribution); their published data is not ours to republish |

## Licensing posture per provider

- All collectors were written from public endpoint observation and the
  technique-level notes in RESEARCH.md — no code was copied from any
  unlicensed repository.
- gputable payloads carry their attribution terms beside the stored payload.
- computable payloads never leave the database; they exist so a human can ask
  "how close are we?" — the answer never ships.

## Secrets

| Env var | Collector | Required |
|---|---|---|
| `HYPERBOLIC_API_KEY` | hyperbolic | no (optional header) |
| `PRIMEINTELLECT_API_KEY` | primeintellect | yes (free — dashboard Settings → API Keys, `Availability -> Read`; absent key ⇒ every run records `auth_failed`) |

No other provider requires auth. Secrets live in `CollectContext.secrets`
only — never in fixtures, never in the database.

## Live status (2026-09-04, after the contract-refresh pass)

**The settlement quorum is restored end to end** — vast, lium, hyperbolic and
runpod all collect live again (2026-09 live books: lium ~160 executors under
the new `price_per_gpu` contract, hyperbolic bare-array `costPerHourCents`,
vast ~40–45 offers per cycle, runpod ~35 GPU types with stock **levels**).
Live engine verdicts the same day: H200 **healthy** (4/4 contributing),
H100 **degraded** (4/4 contributing; 36.5% dispersion is the real cross-tier
market spread), B200 **withheld with the price stored** — 2/4 contributors,
and both holdouts are market reality, not bugs: hyperbolic has no B200 in
their live book right now (`no_usd_observations`), and lium's live B200 book
dedups to 4 machines / 4 hosts, one short of the 5/3 depth floor
(`thin_book` holdout). Withheld is the designed answer to a thin market.

Every other drifted feed was re-anchored this day (parser + re-recorded
fixture + fixture tests, contract visible in the table above):

- **lium** — API contract replaced (bare array, `price_per_gpu` per GPU-hour,
  `costPerHr` gone; executors sharing an IP are one host for dedup/floors).
- **hyperbolic** — bare JSON array, camelCase, `gpuType`+`gpuFormFactor`
  label; tri-state availability from `enabled`/`totalAvailable`.
- **runpod** — `stockStatus` became a stock **level** (`Low`/`Medium`/`High`
  are rentable); the earlier "out of stock everywhere" story was a parser
  bug against the old enum, not a market fact.
- **primeintellect** — moved to the paginated `/api/v1/availability/gpus`
  feed; **a Bearer key is now mandatory live** (free from their dashboard).
  Absent key ⇒ recorded `auth_failed`; the replay pack covers the shape.
- **aws** — `region_index.json` renamed `currentRegionUrl` →
  `currentVersionUrl` (now pins the offer version path).
- **azure** — the OData `armRegionName` filter compares verbatim; the env
  default was the invalid `us-east`. Default is now `westeurope` (9 pages,
  thousands of USD items live).
- **scaleway** — GPU flavors left fr-par-1 entirely: H100 PCIe/L4/L40S in
  `pl-waw-2`, B300 SXM in `fr-par-2`. The collector now walks a zone list
  (`ORACLE_SCALEWAY_ZONE`, comma-separated).
- **crusoe** — the apex now 301s to `www.crusoe.ai`; hardened fetch refuses
  redirects by design, so the URL is pinned to the canonical host.
- **oracle-oci** — `apexapps.oracle.com` is whole-host WAF-gone (403). The
  published GPU list is joined from the price-list page (GPU shape rows with
  `data-partnumber`) and the static `cloud-price-list.json`; the page
  footnote pins the published unit as **per GPU-hour**. Canonical path
  pinned — the old `/cloud/compute/pricing/` URL 301s to
  `/cloud/price-list/` and hardened fetch refuses redirects, which the first
  post-fix live boot caught (the fixture had recorded the final page, so
  replay could not see it).
- **aws (run budget, then the real bug)** — the 60s SLOW lane default cannot
  download the ~480MB region file; every attempt timed out live. The
  collector now declares `runTimeoutMs` (8min) and a 7min deadline for the
  region fetch itself; the scheduler honors per-collector run budgets. The
  first budgeted live run (371s) then exposed the actual defect: the aws
  fixture had been authored with `pricePerUnit` as a bare number, while the
  live file carries a currency map (`{"USD": "…"}`) — the parser written to
  that fixture joined zero terms on live data (103 GPU SKUs, all "without
  on-demand terms") while fixture tests stayed green. The fixture is now a
  verbatim live sample (including capacity-block SKUs that carry terms but
  no positive hourly price) and the parser reads the USD entry of the map;
  the corrected join yields 97 live instance types (confirmed on the next
  live run, 248s end to end) with sane prices — p5.48xlarge $55.04,
  p6-b200.48xlarge $113.93.

Interpretation: the fixture parsers are the contract — offline replay drives
the full pipeline to healthy candidates (all three panels healthy, 4/4
contributing, and `replay:verify` byte-matches every receipt on a quiescent
database). Where a live endpoint disagrees with its fixture (payload shape,
region filtering, auth, URL), the failure is **recorded, not absorbed**: the
collector's breaker opens after 5 consecutive failures, the provider drops
out of the settlement quorum, and the gates either still pass on remaining
providers or the index withholds. Restoring a drifted provider means
re-recording its fixture (`pnpm --filter @gusd/collectors record --provider
<slug>`), updating the parser, and letting the fixture tests prove the new
shape — never loosening a parser to make live data fit.

## Investigation queue (open after the 2026-09-04 refresh pass)

All collection is green except the item below; everything else in this
queue is a worklist/catalog concern by design — unmapped labels are
recorded with occurrences, never guessed into the index.

1. **primeintellect needs its key in the oracle environment.** The collector
   and the paginated feed contract are correct (replay-proven); live runs
   record `auth_failed` until `PRIMEINTELLECT_API_KEY` is set (free key,
   dashboard Settings → API Keys, `Availability -> Read`). This is the only
   env dependency in the fleet.

Catalog/worklist gaps (open `unmapped_labels`, all legitimate — no parser
is wrong here):

- **aws**: all ~97 live instance-type labels (`p5.48xlarge`, `g6e.8xlarge`,
  …) are unmapped — the EC2 offer feed names instances, not GPUs, so the
  mapping (p4d = 8×A100 40GB, p5 = 8×H100, p6-b200 = 8×B200, g6e = L40S …)
  is curated knowledge that must enter the catalog as an explicit
  instance-type table, never inferred from the label.
- **azure (~1.8k)** — the retail catalog carries every `Standard_*` VM
  size; most are non-GPU or outside the v1 datacenter catalog. Bulk family
  mapping is a catalog version bump, not a parser fix.
- **ovh (81)** — `t1-*.consumption` server naming convention.
- **oracle-oci**: `BM.GPU.RTXPro.8` can map to the existing
  `RTX_PRO_6000_96GB` SKU (six providers already normalize to it) once the
  alias is added; `BM.GPU.A100.4` must not be mapped without VRAM evidence
  (OCI's 4×A100 shape has shipped 40GB and 80GB variants — the 25% VRAM
  deviation guard exists exactly so a 40GB A100 cannot impersonate an
  80GB); `BM.GPU.H100.8` is a safe future alias → H100_SXM_80GB (H100 SXM
  ships only 80GB in that shape).
- **runpod / coreweave / akash / shadeform / lium / datacrunch** — consumer
  and older cards outside the v1 catalog (RTX 30/40/50 series, Quadro/RTX
  A-series, GTX 10-series, GAUDI2, `PRO 6000 MIG` slices — MIG slices must
  never impersonate full GPUs).

Known unrelated failure: the foundry contract suite
(`packages/contracts`) fails in `Invariants.t.sol` setUp
(`HookAddressNotValid`) — a pre-existing Solidity/test-harness issue on the
contracts workstream, untouched by and unrelated to the collector refresh.
