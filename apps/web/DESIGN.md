---
name: "gUSD — The Multi-Phosphor Terminal"
description: "A full-color multi-phosphor CRT trading terminal rendered clean: green-black tube glass, readable headings in pale primary ink, the data field in one phosphor hue at four luminance steps, amber function, the cyan wire, zero radius, zero shadow, zero icons."
colors:
  ground: "#050807"
  panel: "#090e0b"
  panel-deep: "#0e1511"
  ph-primary: "#e6f5ec"
  ph-bright: "#66f79a"
  ph-data: "#3ecf72"
  ph-dim: "#2a9455"
  ph-deep: "#1e6b40"
  amber: "#ffb000"
  wire: "#45d4e8"
  up: "#66f79a"
  down: "#ff6b63"
  rule: "#1a2b20"
  rule-strong: "#24402e"
  rule-active: "#3a6a4a"
  rev-fg: "#050807"
typography:
  nameplate:
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', monospace"
    fontSize: "19px"
    fontWeight: 800
    lineHeight: "1"
    letterSpacing: "-0.015em"
  display:
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', monospace"
    fontSize: "34px"
    fontWeight: 800
    lineHeight: "1"
    letterSpacing: "-0.015em"
  hero:
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', monospace"
    fontSize: "30px"
    fontWeight: 800
    lineHeight: "1"
    letterSpacing: "-0.015em"
  wire-figure:
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', monospace"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: "1"
  body:
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "1.5"
    letterSpacing: "normal"
  data:
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', monospace"
    fontSize: "12.5px"
    fontWeight: 400
    letterSpacing: "-0.005em"
    fontFeature: "'tnum'"
  slug:
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', monospace"
    fontSize: "10px"
    fontWeight: 700
    lineHeight: "1.5"
    letterSpacing: "0.14em"
  scale:
    tag-8: "8px"
    tag-8-5: "8.5px"
    tag-9: "9px"
    tag-9-5: "9.5px"
    micro-10: "10px"
    slug-10-5: "10.5px"
    data-11: "11px"
    data-11-5: "11.5px"
    data-12: "12px"
    data-12-5: "12.5px"
    data-13: "13px"
    data-13-5: "13.5px"
    data-14: "14px"
    figure-15: "15px"
    figure-16: "16px"
    figure-17: "17px"
    nameplate-19: "19px"
    card-head-20: "20px"
    page-title-22: "22px"
    strip-hero-26: "26px"
    head-hero-30: "30px"
    display-34: "34px"
rounded:
  none: "0px"
spacing:
  gutter: "12px"
  gutter-md: "20px"
  masthead: "48px"
  status-line: "32px"
  main-pad-top: "20px"
  main-pad-bottom: "80px"
  row-dense: "6px"
  panel-pad: "14px"
  panel-gap: "20px"
  plate-mobile: "320px"
  margin-column: "320px"
  rail-left: "230px"
  rail-right: "310px"
  popover: "240px"
  container: "1440px"
components:
  cmd-input:
    backgroundColor: "transparent"
    textColor: "{colors.amber}"
    typography: "{typography.data}"
    fontSize: "13px"
    fontWeight: 700
    width: "64px"
  cmd-submit:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.rev-fg}"
    typography: "{typography.slug}"
    padding: "4px 10px"
  fn-key-active:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.rev-fg}"
    typography: "{typography.slug}"
    padding: "6px 12px"
  fn-key-idle:
    textColor: "{colors.ph-dim}"
    typography: "{typography.slug}"
    padding: "6px 12px"
  panel:
    backgroundColor: "{colors.panel}"
    border: "1px solid {colors.rule-strong}"
    rounded: "{rounded.none}"
  board-row-selected:
    backgroundColor: "{colors.ph-bright}"
    textColor: "{colors.rev-fg}"
  ticket-submit-buy:
    backgroundColor: "{colors.ph-bright}"
    textColor: "{colors.rev-fg}"
    typography: "{typography.slug}"
    padding: "10px 0"
    width: "100%"
  ticket-submit-sell:
    backgroundColor: "{colors.down}"
    textColor: "{colors.rev-fg}"
    typography: "{typography.slug}"
    padding: "10px 0"
    width: "100%"
  size-input:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ph-data}"
    typography: "{typography.data}"
    fontSize: "15px"
    padding: "10px 12px"
  chart-legend:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ph-data}"
    border: "1px solid {colors.rule}"
    padding: "6px 10px"
---

# Design System: gUSD — The Multi-Phosphor Terminal

## Overview

**Creative North Star: "The multi-phosphor terminal"**

gUSD's web app speaks in the palette of a full-color multi-phosphor CRT text terminal — and in nothing else from the tube. Readable text — every page H1, section prose, explanatory copy — prints in **primary ink**, a pale neutral (#e6f5ec) that sits above the phosphor ramp the way paper text sits above a data field. Green phosphor is the data field: every figure and label prints in one hue at four luminance steps instead of gray levels. Amber is function: the system bar, function keys, panel titles, the command line, active states, premium, errors. Cyan is the wire: the Index and everything the market must be measured against. Red and green, quarantined, are direction. CRT is a color reference only — no scanlines, glow, flicker, or curvature effects. The retro lives in the color system, the mono type, the box-drawn frames, and the function-key culture of the machine; the craft is a clean modern terminal, not a simulation of aging hardware.

The product is organized the way a trader already speaks: **Markets** (the discovery board, pairs named `H100 / gUSD`), **Terminal** (the one roof — the dense professional desk where a market is analysed AND executed), **Index** (the reference benchmarks, `$ / GPU-hour`), **Data** (the interface catalog), **gUSD** (mint the settlement unit + earn with sGUSD — one section, not a vaults catalogue), **Portfolio** (positions, liquid and earning capital, activity), **Protocol** (the machine under the board). The front door is the discovery board itself — what exists, what it trades at, where the Index stands — with execution one click deeper. Discovery first, execution second: the board compares every market, and the Terminal binds one — one canonical price, the chart, statistics, the Index feed, the tapes, the GPU reference, and the trade ticket on a single surface — visibly more capable than the board, not merely darker. There is no second asset-detail surface: `/markets/[asset]` 308-redirects to `/terminal/[asset]`.

The persistent machine shell — sticky system bar, sticky function-key rail, fixed status line — wraps every route; no route ever renders naked. The personality is instrument, not casino: characters and 1px rules are the only ink, and color is quarantined to one meaning per hue.

The system refuses the consumer dark dashboard and every terminal-cosplay idiom: no cards with rounded corners, no glows, no gradients (two functional exceptions — the mobile swipe-fade on clipped boards and the hatch texture on abnormal rows), no illustration, no shadows, no icon glyphs. Emphasis is earned through type size, weight, and reverse video, never through color alone. There is one theme (`color-scheme: dark`); even browser furniture wears the glass — scrollbar thumbs in rule ink, amber carets, a phosphor-green selection.

Built surfaces (the data is layered — see **Data sources & provenance** below): the persistent shell (system bar, function-key rail, status line), Markets discovery (`/` and `/markets` — one component), the trading desk (`/terminal/[asset]` — the retired market detail page 308-redirects here, and bare `/terminal` 308s to the default desk, H100, so every desk owns its URL; `/markets` itself is the discovery board), the Oracle (`/oracle` — one tabbed section: Overview · Benchmarks · Methodology · Health · Developers; `/oracle/[asset]`, `/index`, `/index/[asset]`, and `/data` 308-redirect into it), gUSD (`/gusd` — mint, earn, activity; `/earn` and `/vaults` 308-redirect here), portfolio (`/portfolio`), protocol (`/protocol` — secondary technical documentation, reachable from the Oracle access panel and the command line, never from the nav rail), and an in-world 404. The rail carries the four user modes — F1 Markets · F2 Terminal · F3 gUSD · F4 Portfolio — with Oracle keyless at its far end; nothing in the nav is a dead code. Confirmed rejections: the gray-data terminal that came before (achromatic ink field), consumer fintech dashboards, crypto-casino energy, glassmorphism, CRT effect cosplay, the retired Bloomberg-glass and newsprint worlds.

### Data sources & provenance

The app boots on the **real oracle feed** by default (`NEXT_PUBLIC_DATA_SOURCE=mock` opts out; both `NEXT_PUBLIC_*` values freeze at build time). In oracle mode the `MarketDataPort` (`src/data/oracle/oracle-market-data.ts`) is **API-only**: there is no second price — the benchmark the API publishes is the one price the market and trading surfaces display, and where no venue prices the asset separately the second-price slots do not exist at all (never `—` filler beside the hero). Market-layer facts the API does not publish (venue price, volume, liquidity, tape, trade counts) are `null`/empty and the UI prints `—` or an honest empty state — never a simulated stand-in; basis is structurally `null` with no venue leg to measure, and the premium columns/spans render only where a venue leg exists. What the API *does* publish, the layer serves as series rather than simulating: **OHLC candles for every chart range come from `GET /v1/prices/:gpu/candles`, which buckets the canonical benchmark time series server-side (the database's `index_candidates` — benchmark observations, not trades, not onchain publications; 1m/5m/15m/30m/6h/12h/1d/1w grains over windows sized for 240–365 visible bars)**; the web lazily hydrates each window and merges live SSE candidates into the trailing bucket on the server's own bucket grid — there is no client-side bridge series; the chart renders only what the API bucketed. Sparklines are the series' last 48 hourly closes; window stats (open/high/low 24h and 30d) derive from the candle series gated on real coverage of the window. The Index overlays **every settlement panel** — all seven: A100/H100/H200/B200/B300/GB200/GB300, derived from `SETTLEMENT_PANELS` in `@gusd/gpu-catalog`, never hand-mirrored; when the feed holds nothing for a panel, the Index prints `—` with an `UNAVAILABLE` chip. Prototype execution prices off that same benchmark through the trading port's `priceSource` seam — when the feed asserts no price, orders refuse rather than fill at a simulated one; the inner mock shell survives only as the asset catalogue and the prototype tick clock (earn accrual, demo balances). Only the mock data source fills simulated market figures, and it confesses once on the status line. A wire-faithful fixture server (`pnpm web:fixture`, port 8081) speaks the exact oracle API — `/candles` included — for all seven panels. The seam rules:

- Every oracle-backed Index read carries a provenance chip: `LIVE` (up-green) / `STALE` (amber) / `WITHHELD` / `FROZEN` (down-red) from the oracle publication's status and age; `UNAVAILABLE` (dim) when the oracle asserts nothing. Absent index status means the read comes from the mock data source — the chip renders nothing rather than invent a state; the chip never lies about the source.
- A publication identifies by its `calcHash` prefix, printed as `#xxxxxxx` — never by an invented epoch counter.
- Metrics the oracle does not publish (coverage, latency) print `—` or an updated-age. The web never fabricates a number to fill a cell.
- The status line is source-aware: oracle mode carries no admission — trading, minting, and earning execute against the deployed contracts, and market-layer facts the feed does not publish render as honest empties; mock mode confesses `Demo · all data simulated`.

**Key Characteristics:**
- Tube glass — #050807 ground, #090e0b panels, #0e1511 deep panels; #1a2b20/#24402e/#3a6a4a green-family hairlines; zero radius, zero shadow, zero icon glyphs
- Two text systems: primary ink (#e6f5ec) for headings and prose; the phosphor ramp (bright #66f79a / data #3ecf72 / dim #2a9455 / deep #1e6b40, decorative only) for the data field — no gray exists
- One role per hue: green carries data, amber owns function/active, cyan is the wire alone, red/green own direction
- JetBrains Mono is the sole face — `.num` tabular figures, `.slug` tracked mono caps, `.disp` 800-weight display; evaluated against a second family for prose and retained: one machine voice, hierarchy by weight and size
- Reverse video is the state system: `.rev` amber field (function), `.rev-g` bright-green field (selection/BUY/MINT), `.rev-d` red field (SELL/Disconnect)
- Movement is never color alone: ▲/▼ glyphs plus tone, with size/weight scaling for large moves on the markets table's 24h column; abnormal rows take the hatch texture + a Stale/Delayed tag + a lamp glyph
- The command line and the function-key rail speak the same product names; a bare GPU code routes to that market's page
- Errors speak amber (system messages, validation) — red is quarantined for market direction
- One demo admission, on the status line of a mock-data build only: "Demo · all data simulated" — oracle-mode builds confess nothing (execution is onchain; honest empties speak for the absent venue layer). Surfaces do not re-confess; only unresolved *product concepts* carry a PROTOTYPE tag, and Index reads carry provenance chips (data truth, not confessions)

## Colors

The palette is one tube: three glass tones, one pale primary ink, one phosphor hue at four exposure steps, and three quarantined accents — each committed to exactly one job. No gray exists anywhere.

### Primary ink
- **Primary** (#e6f5ec): readable text — every page H1 and page slug pair, intro and explanatory prose, table identities that must read as sentences. It is deliberately *not* phosphor green: headings are the paper the data prints on. Values, labels, and metadata stay on the ramp. The wordmark stays bright phosphor as the single brand exception.

### The phosphor ramp (the data field)
- **Bright phosphor** (#66f79a): the loudest green. Market figures and hero values (`.disp`), live emphasis, up-moves, the selected row's reverse field (`.rev-g`), the live wire lamp.
- **Data phosphor** (#3ecf72): the workhorse. Figures, board cells, ledger values, sparkline strokes, chart legend values, status-line captions.
- **Dim phosphor** (#2a9455): secondary figures, metadata, column heads, labels, timestamps, idle keys, asides, chart axis text.
- **Deep phosphor** (#1e6b40): decorative strokes only — the hatch texture (45% mix) and breadcrumb separators. It never carries words; text set in deep is a defect.

### Quarantined accents
- **Function amber** (#ffb000): the machine's voice of function. The `>` prompt and command input, the GO key, active function keys (`.rev`), panel numbers and titles, active states, the status line's degraded lamp, Premium figures, MINT/CONNECT fills, error and validation messages, input carets, the focus hairline, the sparkline's live end dot. Amber means *function, headers, active state, and system speech* — never moves, never the Index.
- **Wire cyan** (#45d4e8): the Index's exclusive ink. Index figures on every surface, provider observed prices, Discount figures, Index chart lines, the wire tick flash. Cyan means *the wire and discount* — never decoration, never the market price.
- **Direction** — up reuses bright phosphor (#66f79a), down red (#ff6b63): movement and directional affordances only. Candles and wicks, signed deltas with ▲/▼, Bought/Sold and In/Out tags, the SELL side and submit (`.rev-d`), WITHDRAW hover, Disconnect button (`.rev-d`). Red and green never label anything that is not a move or a direction of the same family.

### Neutral
- **Ground** (#050807): the page ground, row interiors, size-input and receipt interiors.
- **Panel** (#090e0b): raised panels, the bars, the chart legend chip.
- **Deep panel** (#0e1511): one luminance step up — hovered rows, active market-rail entries, the fill receipt, the session popover... never as a second background tone banding one surface's states.
- **Rules** — #1a2b20 (row separators, filler strokes), #24402e (panel borders, strong closes, bar borders), #3a6a4a (scrollbar thumb, chart crosshair): green-family hairlines only.
- **Reverse foreground** (#050807): tube-dark ink that sits on every reverse-video field.

### Named Rules
**The Quarantine Rule.** One role per hue: green = data, amber = function/active/error-speech, cyan = the wire/discount/provider prints, red/green(bright) = direction, deep = decoration without words. A color used outside its role is a defect, not an accent choice.

**The Two-Ink Rule.** Primary ink (#e6f5ec) is for language a human reads as prose: page H1s, page slugs' headline halves, intro paragraphs, explanatory copy. The phosphor ramp is for the machine's data: values, labels, metadata, tables. A body paragraph in data phosphor is a defect; a stat value in primary ink is a defect. The wordmark is the one exception (bright, brand).

**The Luminance Rule.** Within the data field, hierarchy is one hue at four exposure steps. There is no gray, no achromatic data ink, no second text family — hierarchy is stepped phosphor luminance plus weight and tracking, under primary-ink prose.

**The Deep Step Rule.** --ph-deep (#1e6b40) is decorative only: the hatch texture and faint separator marks. Words set in deep are a defect.

**The Wire Rule.** The Index is never styled as a market price. It prints in wire cyan, is labeled "Index" everywhere it appears (with the "$ / GPU-hour" unit on boards, sheets, and the Index pages), sits beside — never merged with — the market figure, and flashes cyan regardless of move direction. The status line repeats the doctrine: "Index ≠ market".

**The Direction Rule.** Movement is never carried by color alone. Every delta prints a sign glyph (▲/▼) and its tone; on the markets table's 24h column the type also scales with magnitude (|Δ| ≥ 4% → 15px bold; ≥ 2% → 13.5px medium; otherwise 12.5px regular). Flat (rounds to 0.00%) drops the glyph and falls back to dim. "Bought/Sold", "In/Out", and ticket sides pair the glyph with the reverse field.

**The Error Voice Rule.** Errors and validation speak amber — the command line's UNKNOWN COMMAND report, the trade panel's error box (amber/40 border, amber/10 fill), mint and earn notes, the degraded-wire lamp, the 404 head. Red is quarantined for market direction; a red message is a defect. WITHDRAW/SELL hover-red is direction voice (outflow), not error voice.

## Terminology

The product speaks plain trader English; abbreviations and legacy jargon are defects. Canonical forms, enforced product-wide:

| Canonical | Banned / legacy |
|---|---|
| Market (a tradable GPU) | Issue |
| `H100 / gUSD` (pair name) | H100, MKT-H100 codes |
| Market Price / Index Price | Last / Wire |
| Premium / Discount | Prem / Disc / Basis (UI surfaces) |
| 24h Volume / Liquidity | Vol / Liq / 24h vol |
| Recent trades | The Tape / prints |
| Index feed | Wire inputs / providers panel |
| Connect / Not connected / Disconnect | Open session / No session / End session |
| Trade (the order panel) | Order ticket |
| Market statistics | Stats |
| gUSD section (mint + earn) | Vaults / Earn pages |
| Units (position size) | Contracts, shares |

"Basis" survives only in advanced technical contexts (Protocol, Data, chart footnotes) where it names the concept precisely. Asset codes (H100, B200) stay bare in figures and command-line input but never stand alone as page titles — pages title the pair.

## Typography

**Sole face:** JetBrains Mono (next/font/local over the committed woff2 files, weights 400/500/700/800, variable `--font-jb`; stack `var(--font-jb), ui-monospace, "SF Mono", monospace`). There is no second family — display, body, labels, and figures are all re-cuts of the same face. A sans/serif companion for prose was evaluated against the machine-print direction and **rejected**: prose reads as terminal output on purpose, and hierarchy is carried by the primary/phosphor ink split plus weight. IBM Plex Mono is banned; VT323 and B612 Mono are out of world. The canvas charts cannot resolve CSS variables or the emitted family name, so the same committed files are re-declared under the stable alias `"JetBrains Mono Local"` (globals.css `@font-face`, weights 400/500/700/800) — one shared download, not a second face.

**Character:** one machine voice, three utilities. `.num` locks every numeral into a tabular digit bank (tabular-nums, −0.005em). `.slug` sets function labels as mono caps on a tracked floor (10px, 700, +0.14em, uppercase). `.disp` sets hero figures at 800 weight, −0.015em — display is a weight, not a second family. Weight in composition: 400 base, 500 (`font-medium`, large-move scaling), 700 (`font-bold`), 800 (`.disp`; panel titles carry `font-extrabold` to sit a weight above their field labels). The 700 channel is the money-figure convention: canonical figures, ledger strong rows, key table cells (prices, Index reads, P&L, basis, portfolio value, desk statistics) and identity figures render bold, while metadata, tape prose, and explanatory copy stay 400 — same-class figures never split between weights. 600 is not loaded; `font-semibold` would silently resolve to the 700 face and is never used.

### Hierarchy
- **Primary heads** (`text-primary`): every page H1 34px `.disp` ("Terminal", "The Index", "gUSD", "Portfolio", 404); intro prose 12.5–13px/1.5 `max-w-prose`. The page slug (10px dim caps) names the section beneath the head.
- **Display heroes** (`.disp`, 800, −0.015em, phosphor): market price 30px bright on detail sheets; identity-strip market price 26px on the desk; portfolio total 26px bright; Index price 30px cyan on Index pages.
- **Identity figures**: wordmark 19px (`.disp`, bright — brand exception to primary); detail Index 20px cyan; desk Index 16px bold cyan; earn APY 16px bold amber; pair symbols 15px bold; size inputs 15px; balances 15px bold.
- **Body/data**: front-door figures 13px; strong ledger rows ("You receive / You pay") 14px bold; large moves 13.5px medium; table base 12.5px (ledgers, recent trades); dense tables 12px (Index board, holdings).
- **Dense data/asides**: 11.5px explanatory asides and notional cells; 11px presets, range tabs, tape clocks, payload pre.
- **Slug/label** (`.slug`, 10px/700/+0.14em): every panel title, table header, button, chip, nav name, and status-line caption. Panel titles carry `font-extrabold` (800) — the one weight step above field labels; table headers render the full slug weight (no un-bold demotion). Status-line figures and stamps step to 10.5px; panel meta sits at 10px.
- **Micro tags** (8–9.5px): sign glyphs ▲▼ at 8–9px, provider lamps at 9px, the Filled tag at 9.5px, Stale/Delayed/PROTOTYPE chips at 8.5px, tape side glyphs at 8px.

The enumerated ramp — the sizes the terminal actually ships, verified by grep across `src/` — is in the frontmatter `typography.scale`: 8 / 8.5 / 9 / 9.5 / 10 / 10.5 / 11 / 11.5 / 12 / 12.5 / 13 / 13.5 / 14 / 15 / 16 / 17 / 19 / 20 / 22 / 26 / 30 / 34 px (22 steps; the body element's 13px is part of the ramp). A font-size outside this list is off-ramp. Cluster reading: micro tags 8–9.5px, slugs 10–10.5px, data and asides 11–14px, identity figures 15–17px, display heroes 20–34px. (The chart's canvas axis text is 10px mono, matching `micro-10`.)

### The unit doctrine
Two tiers of number presentation, by surface density:
- **Canonical stat blocks** carry the unit in the figure, product-standard: `fmtGusd(v)` → "2.485 gUSD" (portfolio values, balances, mint quotes), `fmtPerHour(v)` → "$2.428 / GPU-hour" (Index reference figures). Where a large display figure already sits beside a unit label, the unit is a small dim suffix, not part of the number.
- **Dense tables** keep bare precise numerals (`fmtUsdPrecise`) because the column header carries the unit ("Index Price / GPU-hour", "Price gUSD") — repeating the unit in every cell is noise at table density.

### Named Rules
**The Mono Figure Rule.** Every numeral is JetBrains Mono with tabular figures (`.num`). All formatting flows through the domain formatters (`src/domain/format.ts`) so precision and units stay consistent product-wide — including addresses (`fmtAddress`, 6+…+4) and transaction hashes (`fmtHash`); the full value rides the `title` attribute where space demands the ellipsis.

**The Digit Bank Rule.** Reading lines never wobble: chart legends and axes format with `fmtUsdLegend`, fixed at exactly 3 decimals, so values are comparable across prints. Order-slip ledger rows format at fixed 4 decimals, so price × size ± impact + fee visibly sums. `fmtUsd` (2dp) serves dense tables; percents go through `fmtPctSigned` with `isFlatPct` zero-collapse.

## Layout

A dense function-terminal grid, ruled like a listings board.

- **Container:** max 1440px (`max-w-360`), gutters 12px (20px at ≥768px); main content `pt-5 pb-20` — the 80px floor clears the fixed status line.
- **Shell stack (mount order in `layout.tsx`):** sticky SystemBar (48px, `top-0 z-40`) → sticky FnKeys rail (`top-12 z-30`) → main → fixed StatusLine (32px, `bottom-0 z-40`). Both bars and the rail are panel glass over a rule-strong edge; the status line is fixed to the viewport on every route.
- **Function panels:** 1px rule-strong boxes on panel glass. The panel number and amber slug title sit on the top rule with a hairline continuing the stroke; optional dim note after the title, mono meta at the rule's far end, and a right-hand control cluster (tabs, links). Numbering is per-surface: Markets discovery runs 01 class overview / 02 GPU markets / 03 48h charts; the desk runs 01 markets / 02 chart / 03 trade / 04 premium-discount history / 05 market statistics / 06 index sources / 07 recent trades / 08 all-market tape / 09 underlying GPU (plus the unnumbered index feed and position panels); gUSD switches two tab views that each number their own panels (mint: 01 get desk — the single surface, currency-first picker / 02 mint activity; earn: 01 earn desk / 02 earning ledger) beside the unnumbered balances rail; Oracle runs five tab views that each number their own panels from 01 (Overview: pipeline / why trust it / index ≠ market · Benchmarks: index board + inline panel receipt / reference history · Methodology: pipeline stages / provider registry / methodology version · Health: publication status / collector health / panel freshness · Developers: interface catalog / endpoint reference / code samples / streaming / historical data / access); Portfolio runs 01 positions / 02 liquid capital / 03 earning capital / 04 protocol positions / 05 activity.
- **The dominant plate:** the chart is the largest object — 384px tall on mobile; at ≥1024px the desk plate is a flex column that fills its grid row (the row's height is the tallest column's, so the plate bottoms out with the 310px rail) with a 380px floor; the discovery chart holds 50vh.
- **Rails:** the trading desk is deliberately dense — a 230px markets rail (markets, position, underlying GPU), fluid plate, 310px trade-and-index rail (trade ticket, then the Index feed — the ticket's reference leg). The row's height is its tallest column's; the plate is a flex column whose chart fills the row, and the markets frame grows to tile the rail down to the same line (slack sits inside the frame beneath the list, the way a board's empty quota does) — no column strands ground before the bands beneath. Beneath the plate run a full-width market-statistics strip (the ledger dl tiled 2/3/5 columns so the desk's widest band keeps the desk's density) and the activity zone (this market's tape, then the all-market tape); gUSD binds a 320px rail (balances + earning ledger). The desk's markets-rail entries are links to each market's own desk (`/terminal/[asset]`, `aria-current` marks the bound one) — switching markets changes the route, so the URL always names the market on screen. Below 1024px everything stacks into tabbed tasks (Overview / Chart / Trade / Activity — the Index feed rides the Trade task, where the desktop rail puts it); panel numbers follow the desktop Z-scan, 01–07.
- **Mobile is task-oriented, desktop stays spatial.** Below 1024px the desk presents a five-tab task strip — `Overview | Chart | Trade | Index | Activity` (`TabBar`, `role=tablist`, active tab reverse amber) — and stacks tasks sequentially (Overview: markets rail, position, GPU reference, statistics · Chart: plate · Trade: ticket · Index: Index feed, premium history, sources · Activity: both tapes); the desktop grid is untouched. Implementation contract (the no-phantom-gap pattern): panels inside a cell that hosts several tasks toggle a per-panel `hidden` class (`vis(name)`), while cells that host exactly one task hide at the **grid-item level** (`cellVis([...names])`) — an empty-but-visible grid item still creates a track, and `gap` paints rows between empty tracks, so single-task cells must be `display:none` as items. Charts mount exactly once (hidden ≠ unmounted); tab state is component state, not a route change.
- **Tables:** hairline rows, slug column heads, right-aligned tabular figures. Wide boards scroll horizontally with the identity column sticky (`left: 0`) so the pair never leaves view; a 32px ground-fade advertises the swipe on mobile.
- **Breakpoints:** Tailwind defaults — 640px, 768px, 1024px, 1280px. The rail and status line scroll horizontally rather than wrap.

## Elevation & Depth

There are no shadows anywhere — not even the focus ring is a shadow blur (it is a 1px amber box-shadow hairline). Depth is carried by three mechanisms: panel tone (panel lifts above ground; deep panel lifts again for hover/active contexts), rule strength (rule → rule-strong → rule-active), and z-layers (system bar and status line z-40, function rail z-30, session popover z-50 over a z-40 scrim, sticky board identity cell z-10, chart legend z-10). Flash tints wash a cell once and drain to nothing.

### Named Rules
**The Flat Glass Rule.** Zero shadows, zero blur, zero glow, zero radius. If a surface needs to lift, step its glass tone, strengthen its rule, or go reverse video — never light it.

## Shapes

Zero radius is absolute: panels, inputs, chips, popovers, buttons, scrollbar thumbs, flash tints — every rectangle is square. Borders are the 1px hairline system; there are no thick rules — emphasis comes from reverse video or a stronger hairline. Focus is the amber hairline: `box-shadow: 0 0 0 1px var(--color-amber)`, radius 0. There are no icon glyphs of any kind — marks are characters: ▲ ▼ ▶ ● ◐ ○ █ ░ and the box-drawing strokes │ ▼ ─ of the ASCII pipeline diagrams.

Recurring devices (exact scope):
- **Reverse video:** `.rev` (amber field, tube-dark text) for function activation — active fn key, GO, connected account, CONNECT, MINT, 404 return, Filled tag; `.rev-g` (bright-green field) for selection and BUY; `.rev-d` (red field) for SELL and Disconnect. Selection is a reverse field, never a background tone band.
- **Swipe fade:** a 32px ground-to-transparent linear fade over a horizontally clipped board, mobile only (`lg:hidden`), purely functional — one of exactly two gradients.
- **Hatch (`.hatch`):** a −45° repeating hairline texture (deep phosphor at 45%, 5px/1px cadence) behind any abnormal source row — the second and last gradient.
- **Tick flash:** `.flash-up` rgba(102,247,154,0.2) / `.flash-down` rgba(255,107,99,0.2) / `.flash-wire` rgba(69,212,232,0.18), one 0.7s ease-out wash to transparent.
- **ASCII weight bars** (Index weighting panel): `█░` character blocks at 10px mono — data drawn in the character grid, never a chart icon.

## Components

### SystemBar — the machine's top rule
Sticky 48px strip on panel glass (`top-0 z-40`, rule-strong bottom edge). The bright `gUSD` wordmark (19px `.disp`) with "The GPU Assets Protocol" slug at ≥768px; the command line; the connection control; the UTC clock (12px mono, 1s cadence, ≥640px).

**The command line (signature).** An amber `>` prompt (15px bold), a bold amber lowercase-tolerant input (13px, 64px wide / 112px at ≥640px, placeholder "terminal B200" in dim), and the GO key in reverse amber. It speaks **product names, not codes**: `markets`, `terminal`, `oracle`, `gusd`, `portfolio`, `protocol` (case-insensitive; `board` aliases markets; `index` opens the Oracle's Benchmarks tab; `data` opens its Developers tab), each accepting a bare asset argument (`terminal B200`; `oracle B200` and `index B200` deep-link the Benchmarks tab with that benchmark's receipt open); bare `terminal` opens the default desk (H100); `gusd`/`sgusd`/`mint`/`earn`/`vaults` all land on `/gusd`; a lone asset code (`B200`) routes to that market's desk, as does `markets B200` — the bare `markets` command is the board. A rejected input prints `UNKNOWN COMMAND "X" — TRY MARKETS · TERMINAL · ORACLE` in amber slug, `role="status" aria-live="polite"` — inline at ≥1024px, as a strip under the bar below — and the line self-clears after ~3.2s. The caret is amber.

**Connection control (`ConnectControl`).** Disconnected: a dim slug bordered button "CONNECT" ("CONNECTING…" while the flow opens or the wallet resolves) that turns amber on hover. Connected: the wallet's display address (`fmtAddress`, 6+…+4) in reverse amber opens a popover (240px, panel glass, rule-strong border): the **Wallet row** (display address plus a COPY key that flashes "COPIED" for ~1.6s), the **Network row** (the wallet's chain label with a `●` lamp — green on the desk's chain, amber on a foreign one, `—` while unknown), the gUSD / sGUSD / positions rows, and a Disconnect button in `.rev-d`. When the backend identity sync has expired, an amber box row ("Connection expired — reconnect.") sits above the ledger. In demo mode (no wallet configured) the wallet and network rows are absent — the popover stays the plain ledger. Connection language is plain: never "session".

### FnKeys — the navigation rail
Sticky at `top-12` (z-30), rule-strong bottom edge, horizontally scrollable, never hidden. Split by audience: four **function keys** carry the user's operating modes — F1 Markets · F2 Terminal · F3 gUSD · F4 Portfolio — each a real link with the full product name (aria-current when active); the active route reverse-videos amber (F1 is also active on `/`); idle keys sit dim and hover to data phosphor on deep panel; the F-prefix stays dim (70%). **Oracle** rides the rail's far end, pushed right behind a flex rule and a `border-l` hairline: no F-key, idle text in wire cyan (brightening on hover), active reversed in `.rev-w` — system reference infrastructure, visually outside the user-mode cluster on every viewport. Protocol is intentionally absent from the rail; it stays reachable through the Oracle access panel and the command line. The command line speaks the same names.

### StatusLine — the permanent foot
Fixed to the viewport (32px, z-40, rule-strong top edge): a 9px lamp + "Index feed" slug; the H100 candidate's sources "N/M", the updated age (ticking on a mount-gated clock — the server render prints the absolute stamp, so hydration never mismatches), and the publication `#hashprefix` (≥768px) in 10.5px dim mono; a filler hairline; then the cautions in amber slug — "Index ≠ market" plus, in mock mode only (≥640px), the admission "Demo · all data simulated"; an oracle-mode build carries no admission — execution is onchain and the provenance chips speak for the data. **The lamp reads the wire, not a wish**: green only when the SSE connection is live AND the Index is fresh AND every observed source is contributing; red when the feed is down or the publication is withheld/frozen; amber otherwise (connecting, polling, stale, degraded, partial sources). **This is the product's single demo admission**: no surface scatters its own "simulated" confessions; the status line confesses once for the whole machine.

### ConnectDialog — the one connect surface
`src/components/shell/connect-dialog.tsx`. Opened by `auth.connect()` from any CTA; a pure view of the auth port's connect flow — the adapter owns every transition, the dialog renders the step and feeds instructions back through `flowAction`. A TuiPanel (`01 · CONNECT`, dim ESC key in the head's right cluster) over a `bg-ground/70` scrim, 320px max, `z-40` scrim / `z-50` dialog, zero radius. **Method step — wallets are the dominant path:** every wallet the browser announced (MetaMask, Rabby, Brave, "Browser wallet" — names as text, never logos) gets a bordered cell under "Connect a wallet" (`.slug` name left, amber `>` prompt right, hover turns the border and name amber); first in the panel and first in the tab order. When nothing announced itself the section is replaced by the honest note "No wallet detected in this browser — continue with email below." Email and Google demote below the hairline ("Or continue with email"): amber `>` prompt, ground-glass input (13px mono, focus turns the border amber), full-width `.rev` CONTINUE, then a dim GOOGLE row. Wallet Connect ships only with its transport. **Email step:** "Check {email} — enter the 6-digit code." with the address in bright, a centered 6-cell code input (15px mono, 0.4em tracking), `.rev` VERIFY ("Verifying…" while busy) and dim RESEND / CHANGE EMAIL. **Waiting states** speak as amber slug + blinking block cursor (▌, `animate-pulse`): CONNECTING… / AWAITING SIGNATURE… with the wallet's name dim beneath / PREPARING WALLET… / CONTINUE IN THE POPUP…. Every rejection lands in the amber box voice ("Signature declined. Connect again to continue.") with a dim bordered TRY AGAIN returning to the method list. **Behavior:** `role="dialog" aria-modal="true"`, ESC cancels from anywhere, scrim click cancels, focus enters the step's first control, Tab is trapped inside, the invoker regains focus on close, and the body is `aria-live="polite"` so step changes and errors announce.

### NetworkStrip — the wrong-network condition
The one persistent shell element the wallet layer adds: a full-width amber system strip directly under the SystemBar (`border-b border-amber/40 bg-amber/10`) while `connected && networkOk === false`. Content: "WRONG NETWORK — THIS DESK TRADES ON ANVIL" in amber slug, a `.rev` SWITCH key ("Switching…" while the port talks to the wallet — adding the chain when the wallet lacks it), and a dim DISMISS. A declined switch leaves the strip standing — the strip IS the error surface. Dismissal is per-condition: resolve the chain, change it, or reconnect and the strip returns if the condition does. `role="status"`.

### TxReceipt — the chain receipt grammar
`src/components/ui/tx-receipt.tsx`. Extends the order-slip receipt grammar to chain transactions: kind slug dim + status tag on the first row; hash (via `fmtHash`) and detail on the second. **Confirmed** wears the reverse-amber tag (the "Filled" pattern) with "block N"; **in-flight** states print an unboxed amber tag (SIGNING / SUBMITTED) with dim "confirming…"; **reverted / failed / declined** take the amber-bordered tag, and the record's product-voiced reason prints in the amber box — a revert is amber, never red. `aria-live="polite"`. Its only live producer is **TxDevPanel** (`NEXT_PUBLIC_ENABLE_TX_DEV=1`; panel 99, deep-panel body, a `.rev` SEND SELF-TX key) — the dev fixture that exercises the full transaction lifecycle; product surfaces keep demo fills until protocol actions land, per the honest-machine doctrine.

### TuiPanel — the frame grammar
`border border-rule-strong bg-panel`; header row with the panel number (12px bold amber mono), the amber slug title, an optional dim slug note, a flex-1 filler hairline continuing the rule, dim mono meta, and a right cluster. Every surface composes from this one frame.

### Markets discovery table (signature component)
The front door (`/` and `/markets` render the same `MarketsDiscovery`): 01 class overview (asset-class figures), 02 **GPU markets** — the discovery table, 03 48h charts (every market, equal weight, sparklines). The table is discovery, not execution — no ticket lives here. Columns: Market (pair name `H100 / gUSD`), Price, 24h (▲/▼ + tone, magnitude-scaled), Index Price (cyan, "/ GPU-hour" in the head), Premium/Discount (amber at a premium, cyan at a discount), Volume, Liquidity — full words, unit-carrying heads, bare numerals in cells. In oracle mode the venue columns (Price, 24h, Premium/Discount, Volume, Liquidity) print `—` until a market layer exists — the Index column carries the price. Rows hairline-separated, hover to deep panel; the identity cell is sticky left and links to the market's desk (`/terminal/[asset]`). Row click = navigate (discovery routes deeper; it does not bind a ticket beneath).

### Trade panel (`OrderSlip` — the execution furniture)
Panel 03 "Trade · fee 6 bps" on the desk — the one execution surface. **Connect-gated:** disconnected, submit prints the amber connect error ("Connect to trade — demo capital is provided once connected."); the panel never shows a fake session. **Side switch:** a two-cell bordered grid — the selected side fills in its direction field (`.rev-g` buy / `.rev-d` sell) with its ▲/▼ glyph; idle cells dim. **Size input:** a rule-strong field on ground glass, 15px tabular mono, digits-only filtering, 1/4/10 preset cells divided by hairlines, focus-within turns the border amber. **Quote ledger:** slug label + mono value rows at 12.5px — est. price, est. impact, est. fee — closing on the strong "You pay / You receive" row (14px bold bright phosphor); every price prints at ledger grade, fixed 4 decimals, so the rows visibly sum. **States:** validation prints in an amber box (`border-amber/40 bg-amber/10`, 11.5px); a fill prints a receipt on deep panel carrying the reverse-amber "Filled" tag (9.5px) and the print's figures at 4 decimals. **Submit:** full-width slug button filled in the side's field, 40% opacity disabled, 90% on hover, "Placing…" while pending. Foot: "Fee 6 bps · impact ~3 bps per unit" (10px dim).

### Recent trades (the tapes)
Two grammars, one pattern, both on the desk: the **per-market tape** (panel 07) prints that market's last 14; the **all-markets tape** (panel 08, beneath it) merges every market's prints newest-first (18 cap), each tagged with its market slug, closing "7 GPU markets · priced in gUSD". Rows: market/clock in dim mono, "Bought/Sold" (or "In/Out" on earn) in move tone with an 8px glyph, size @ price in 12.5px data phosphor, notional right in 11.5px dim. In oracle mode the tape is honestly empty — "No trades yet — the tape prints when the venues go live" — never seeded with simulated prints.

### Chart plate (signature component)
The TuiPanel plate: amber numbered head, mono meta stating the selected grain ("1m candles · UTC" … "1w candles · UTC" — the selector label IS the candle grain, mirroring the server's series plan), the interval selector on the head's right (11px mono, bottom-bordered, the active interval amber: 1m 5m 15m 30m 6h 12h 1d 1w — TradingView grain idiom), and the caption foot "Benchmark series · candles from the canonical benchmark history" — the candles are the benchmark's own series, server-bucketed, never simulated.

- **Renderer — TradingView Advanced Charts (self-hosted, `public/charting_library/`, CL v31.2.0):** the desk chart is a licensed Advanced Charts widget (`tv-price-chart.tsx`), not a hand-built canvas. TV's own chrome is disabled (header, toolbars, timeframes switcher, search, settings persistence) — the TuiPanel head and interval selector ARE the chart's chrome — and the built-in legend stays. The widget renders in an iframe that does not inherit the app's CSS custom properties, so the palette lives as literals in two places: the widget `overrides` and `custom-theme.css` (restates the panel surface, vendors the JetBrains Mono variable woff2 into the iframe, restyles the legend chip). Widget creation gates on a measurable container (the mobile tab strip hides-but-does-not-unmount chart cells; a 0×0 iframe is the blank-pane bug).
- **Datafeed — the backend is the source of truth (`tv-feed.ts`):** history is REST-only against `GET /v1/prices/:gpu/candles` (the server-bucketed canonical benchmark series; windows clamped to the endpoint's 2000-bucket cap so scroll-back never trips the server's 400). Realtime rides the shared feed store — the same SSE connection the desk's stats use — with server-grid-faithful folding (`fold.ts`), so the chart, the hero, and the stats share one series state and no client-side OHLC is ever derived. A server resync that re-buckets history is detected as a structural reshape and answered with a debounced `resetData()` — the chart reloads from the API rather than papering over stale bars. Mock mode feeds the widget from the `MarketDataPort` snapshot so the demo build stays network-free. Unit contract (a real footgun, pinned by test): history-request `periodParams` are epoch **seconds**, but bar `time` is epoch **milliseconds** — the library's own reference datafeeds pass ms open times straight through; dividing to seconds anchored every bar in 1970 and blanked the pane.
- **OHLC only — no volume, ever, until it is real:** benchmark candles carry O/H/L/C and nothing else. The widget's default Volume study is stripped on chart-ready (`activeChart().getAllStudies()` → `removeEntity` for "Volume") and the symbol serves no volume fields — a volume surface with no data behind it renders only an error badge. No synthetic or inferred volume is generated, displayed, or charted anywhere. When GPU markets build real trading activity, OHLCV comes from actual swap volume in the market data pipeline — added as data, not approximation.
- **Theme (widget overrides, same literals the canvas chart used):** pane background #090e0b solid; grid rgba(26,43,32,0.55); crosshair #3a6a4a dashed 1px with label chips in #24402e; scale text #2a9455 at 10px, scale line #24402e; candles UP #66f79a / DOWN #ff6b63, **borderless** (`drawBorder: false` — at dense intervals a 1px border turns a candle into a filled block and eats the open/close gap). A **last-price line** carries the live close at #3a6a4a (`showPriceLine` — this CL build's property name; the line style itself is not overrides-exposed, so the build's own dotted default stands, and per-direction recolor has no overrides equivalent — the line holds the dim green instead of following the bar's move color). `pricescale: 10000` (4dp) — the benchmark moves in fractions of a cent, and a 2dp format rounds them into a flat line.
- **Legend:** TV's built-in legend (feature `legend_widget`), restyled by `custom-theme.css` to the terminal's chip contract — panel surface #090e0b, 1px rule #1a2b20, 6×10px padding, 11px JetBrains Mono, data-phosphor #3ecf72. Values print at the symbol's 4dp price format (TV's own formatting replaces `fmtUsdLegend`'s 3dp — a deliberate delta to the Digit Bank Rule: one decimal more, still fixed-width, still comparable across prints).
- **Time axis:** TV's own tick marks under `timezone: "Etc/UTC"`, session `24x7`. Weekly buckets are epoch-aligned (Thursday 00:00 UTC — the epoch is a Thursday), so the 1w axis anchors on Thursdays by the server's own grid; the chart renders the server's timestamps untouched.

### IndexChart — the wire alone
The reference series plate (`index-chart.tsx`): a single 2px cyan line, cyan crosshair marker, no candles, no band. Axis text #2a9455 at 10px; grid/crosshair/rule literals shared with the price chart; price scale margins 0.18 top and bottom. **Required:** `priceFormat: { type: "price", precision: 4, minMove: 0.0001 }` — the Index moves ~1bp/day, and the default 2dp price format rounds every tick of the day to one identical string, which suppresses all axis labels. Legend: "Index" slug in cyan, the 12px bold cyan figure at 3 decimals, the 10px dim time stamp. `fitContent` on data change.

### Provider receipt (Oracle Benchmarks; retired from the desk)
The provider panel grammar: a 12px table — lamp (● live bright green / ◐ delayed amber / ○ stale dim, 9px), provider name (12.5px), weight, observed price in wire cyan, coverage, relative age. Any non-live row takes the `.hatch` texture + an explicit bordered tag ("Stale" / "Delayed" at 8.5px) + its lamp glyph — texture, word, and lamp name the abnormality together; never color alone. Aside: "Sources inform the benchmark — they never set the market price." The desk is a trading surface and carries no provider table; its Index feed panel links to the Oracle's Benchmarks tab, which prints this grammar as an inline **panel receipt** under the board, per selected benchmark: lamp, name, weight, method, σ, sample, observed age, executable — plus the window's exclusions beneath.

### Ledgers (Market statistics, Underlying GPU, Balances, mint/earn quotes)
Slug-headed `dl` grids (2 columns mobile, 3–5 desktop): slug label dim left, tabular mono value right, over a hairline bottom rule. Strong values step to 14–15px bold; canonical figures print with their unit (`fmtGusd`, `fmtPerHour`) per the unit doctrine.

### Breadcrumb & chips
Slug word links ("[Markets]", "[Oracle]") brightening to amber on hover, a deep-phosphor `/` separator (decorative), the current pair in 12px mono data phosphor. Bordered 8.5–9px slug chips are reserved: "Stale", "Delayed", "Benchmark", "PROTOTYPE" tags on unresolved product concepts, and the Index provenance chips (`IndexStatusChip`: LIVE/STALE/WITHHELD/FROZEN/UNAVAILABLE beside oracle-backed Index reads where provenance is the point — the desk plate and the Oracle's Health tab; the discovery board's price listing and the Oracle's Benchmarks board omit them — a board of rows reads as numbers, not statuses, and the receipt and the Health tab carry provenance there — LIVE up-green, STALE amber, WITHHELD/FROZEN down-red, UNAVAILABLE dim; absent status renders no chip). Breadcrumbs speak words, never codes.

### TabBar (task switcher)
`grid grid-flow-col auto-cols-fr border border-rule-strong bg-panel`, `role=tablist`. On the desk it is the mobile task strip (`lg:hidden`; Overview / Chart / Trade / Activity — the Index feed rides the Trade task, the ticket's reference leg). On the gUSD section it is the flow switcher on **every viewport** — Mint gUSD / Earn with sGUSD — because the two paths must switch, not stack. Tabs are ReactNode entries so pair/unit casing survives the slug caps; labels render `font-extrabold` (800, a weight above field labels — the switcher is a primary control); the active tab reverse-videos amber; idle tabs dim, hover to data. `aria-label` names the surface's sections or flows.

### gUSD desks (`/gusd`)
One section for the settlement unit and earning — never a vaults catalogue. The two flows never stack and never blur: a full-width **TabBar** under the model strip switches **Mint gUSD | Earn with sGUSD** (active reverses amber; `hidden` tabpanels keep form state alive across switches). Each tab view numbers its own panels from 01. **Mint gUSD (01)** is the Get desk — one surface for the whole funding task, `any supported stable → gUSD`, where bridging and the en-route conversion are machinery the desk performs, never a second interface. One source picker states where value starts, **currency first** — the row the user thinks in ("I have USDC"): funding stables with the reserve leading, bridge origin tokens merged in by symbol, remote-only currencies after. A chain row scoped to the selected currency follows — the deployment chain by its own name ("Robinhood", "Anvil"; never "this chain"), then the bridge-served origins that carry that currency (capability-gated — `crossChainFunding` in the chain registry; the row hides when a currency spans one chain) — then a direction switch (MINT/REDEEM), a plain amount input (25/50/100 presets where a balance is readable; free-typed on remote origins), and one composed quote ledger that speaks the execution's own math (`You send · chain / Route — swap or bridge → reserve · mint / Fee — bridge + mint bps composed / You receive / Guaranteed floor — printed whenever a leg signs one / Fill time` in `fmtGusdLedger`), the route row dim, amber notes only where a route genuinely can't be priced. One CTA carries the whole route: it is the connect button until a wallet exists ("Connect & mint" / "Connect & bridge" / "Connect & redeem" — connect lives inside the desk, never behind a wall), then runs every leg through one action path — remote executes bridge → mint automatically at the quote's guaranteed floor (the two-step lane prints Step 1 · Bridge / Step 2 · Mint; failures partition into "no funds moved" vs "funds landed in the wallet as the reserve", and the landed-funds voice names the actual recovery: switch the source to This chain → reserve and mint). Reading stays public — local quotes price without a wallet; remote quotes need one because they lock to the receiving address. The reserve asset is the home asset — its chips read "USDG · Global Dollar" via `stableLabel`, never bare symbols. No market positions, no Index reference — position↔gUSD conversion at the Index is a model the product explicitly does not have. **02 Mint activity**: mint receipt rows. **Earn with sGUSD (01)** keeps `gUSD → stake → sGUSD`: the public rate block first (trailing 30d APY bright amber + PROTOTYPE chip, sGUSD rate, accrued), the capital framing line ("gUSD is liquid protocol capital; sGUSD is that same capital deployed into the earning layer"), then stake/unstake switch, presets, projection ledger, `aria-live` notes. **02 Earning ledger**: In/Out rows, moved into the earn tab so each flow carries its own history. Right rail: **Balances** only (disconnected: "Not connected" tag + prose + amber ACCESS gUSD button wired to `auth.connect()`; connected: Liquid · gUSD / Earning · sGUSD / Positions rows).

### Oracle (`/oracle`)
The reference layer, reworked from a per-GPU catalogue into the section that *explains and exposes the pipeline*: one tabbed surface — a full-width TabBar switches **Overview | Benchmarks | Methodology | Health | Developers** on every viewport, and `hidden` tabpanels stay mounted so a selected benchmark and its loaded receipt survive a switch. Deep links carry `?tab=` and, on Benchmarks, `&bench=` (`/oracle?tab=benchmarks&bench=B200`); the old per-GPU sheet `/oracle/[asset]` and `/index(/:asset)` 308-redirect into that shape and `/data` lands on Developers; in-page switches mirror back into the URL with `history.replaceState` (no navigation, back-button-friendly). Per-tab panel numbering from 01.

- **Overview** — how the number is made: the lead doctrine ("Every market on this exchange settles against a benchmark it does not set"), **01 Pipeline** (the real nine-stage ASCII diagram — SOURCES at FAST/MEDIUM/SLOW cadences with the collectors named, append-only INGEST, NORMALIZE, PANEL, SCREENS, WEIGHTS, AGGREGATE, GATES, PUBLISH, CONSUME — every parameter on it the shipped value), **02 Why trust it** (append-only ledger · byte-reproducible receipts · independent publisher validation · provenance on every figure), **03 Index ≠ market** (the doctrine panel).
- **Benchmarks** — **01 Index board**: the benchmark table (cyan figures; the market-price and premium columns render only where a market layer prices the rows; no provenance chips — a board reads as numbers, and provenance lives in the receipt and the Health tab). Rows **select, not navigate** — the selected row's name brightens, a `receipt ▾` affordance appears, and an inline **panel receipt** prints beneath the table (head names `GET /v1/prices/:panel/providers` and stamps `computedAt`; contributors as lamp/name/weight/method/σ/sample/observed-age/executable; exclusions beneath; pending and 404 print honest lines). **02 Reference history**: the wire-alone chart with benchmark + range switchers, fed from the feed store's server-bucketed candles (`useOracleSeries` — the market snapshot's `index: []` is deliberate); an amber note says when real history is shallower than the selected range.
- **Methodology** — **01 Pipeline stages**: the engine's real v0.2.0 thresholds as a stage/rule/parameters table plus the four verdicts (healthy/degraded/stale/withheld) and "withheld is safer than fabricated"; **02 Provider registry**: `GET /v1/providers` as name/type/role/cadence rows — settlement-eligible in data phosphor, the rest dim, "collection breadth is not settlement eligibility"; **03 Methodology version**: the live `methodologyVersion` from the wire (`—` pre-publication), versioned-not-mutated, thin-SKU overrides capped at `degraded`.
- **Health** — the oracle reporting itself: **01 Publication status** (publication `#hashprefix` of the most recent candidate, updated, live sources summed across panels, overall, database), **02 Collector health** (`GET /v1/health` per-collector rows with mount-gated stamps; an open breaker takes `.hatch` + amber BREAKER OPEN + ◐), **03 Panel freshness** (a row per settlement panel — chip + last-publication age; "freshness is the oracle's own verdict, not the page's").
- **Developers** — the oracle as a data product: **01 Interface catalog** (the server's route table verbatim: 9 LIVE, 1 PROTOTYPE market-snapshot seam, 2 PLANNED; "nothing here invents endpoints that don't exist"), **02 Endpoint reference** (parameter table; the annotated `CandidateDto` shape beside the as-served payload — live candidate or clearly-labelled sample), **03 Code samples** (curl / TypeScript / Python against this deployment's `NEXT_PUBLIC_ORACLE_URL`, COPY keys, "plain GETs, CORS open; no keys"), **04 Streaming** (SSE wire excerpt beside the semantics: `event: candidate` frames, `: ping` every 15 s proving the transport not the data, ≥10 s debounce, lossy-by-design — re-read REST on open; WS variant envelope-wrapped), **05 Historical data** (the candles contract: 9 intervals, 2000-bucket cap, default trailing 24 h, oldest-first, `carried` buckets assert silence never a level), **06 Access** (open today — the tier line finalizes with the protocol integrations; points to `/protocol`, Protocol's only organic doorway from a surface).

Index stays the benchmark *name* (H100 Index); Oracle is the *section* that observes inputs, produces the benchmarks, and publishes them.

### TickFlash (signature behavior)
`src/components/ui/tick-flash.tsx` — a figure that re-prints when its value moves. The span is keyed on the value, so a change remounts the cell with the flash animation already running (0.7s ease-out wash, once). `flash="move"` (default) picks up/down from the direction; `flash="wire"` flashes cyan regardless of direction, keeping Index ticks inside the cyan quarantine. The first render never flashes — a landing tick does, not the initial print. All flash animation is disabled under `prefers-reduced-motion`. Verification note: flash behavior is verified at the code level; **flash-wire's live timing in a running browser still deserves one human confirmation** — static rasters cannot prove it.

## Honest-machine doctrine

The product confesses exactly once, and never invents unresolved protocol mechanics:
- **The single demo admission** lives on the status line of a mock-data build: "Demo · all data simulated" (amber slug); oracle-mode builds carry no admission at all. Surfaces do not repeat "simulated", "prototype feed", "no venue involved", or "wallet integration coming later" as scattered copy — repeating the confession is noise, and dev-voice copy ("simulated prints", "nothing broadcast") is a defect. Fill receipts and panel metas describe *what happened* ("Filled", the chain hash), not what didn't.
- **PROTOTYPE tags mark product concepts, not mock data:** the trailing 30d APY on Earn, the mint panel's mechanics note, protocol pools. A tag says "this mechanism is not final", never "this data is fake" (the status line already said that).
- **Provenance chips are data truth, not confessions:** LIVE/STALE/WITHHELD/FROZEN/UNAVAILABLE state the oracle's publication status and age for an Index read. They sit beside the Index reads where provenance is the point (the desk plate, the Oracle's Health tab) and never decorate; boards of rows omit them; the mock data source renders no chip — its admission lives on the status line alone.
- **The web never fabricates a number to fill a cell:** metrics the oracle does not publish (coverage, ingest latency) print `—` or an updated-age; a publication identifies by its `calcHash` prefix (`#xxxxxxx`), never an invented epoch counter; and when oracle history is shallower than the selected chart range, an amber depth note says so instead of letting a short line imply a quiet market. The same rule covers market-layer facts: in oracle mode no venue price, volume, liquidity, tape, or trade counts exist, so those cells print `—` or an empty state — a simulated stand-in is a fabrication.
- Errors are product-voiced and actionable: "Connect to trade — demo capital is provided once connected." / "Mint rejected — connect, then enter a deposit amount." / "The fill failed. Adjust the order and try again."
- The Index is visually distinct from the market price on every surface — cyan vs green, always labeled, with the "$ / GPU-hour" unit on boards and Index pages; the status line repeats "Index ≠ market". When no venue price exists (oracle mode) there is no second figure: the benchmark takes the hero slot — wire cyan, "/ GPU-hour" unit, its own 24h move — and the second-price slots (columns, spans, cells) are removed at the surface level rather than printed as `—`.
- **The stable-labeling rule — identity is never symbol-sourced:** gUSD (the product) and the chain's reserve asset (USDG on Robinhood Chain; the Anvil dev mock wears USDG's identity too, so every dev session previews the real posture; USDC where USDC is canonical) are different tokens whose names rhyme, so every funding stable renders identity through `stableLabel` — "USDG · Global Dollar", "USDC · USD Coin" — sentence-level, and the product token renders only through `<Gusd/>`/`<SGusd/>`. A funding asset's on-chain `symbol()` is never read: lookalike USDC/USDT scam tokens exist on every chain, so identity comes from the deployment record cross-checked against hand-written display config, and a mismatch throws instead of rendering a token the router would reject. Bridge origin tokens are the same posture: hand-vetted canonical issuers, symbol-as-label only — with Paxos-native USDG first on the chains where the bridge actually serves it, so the default origin moves across directly.
- Unresolved mechanics are named, not invented: the mint desk quotes the contracts' own previews (fees at the configured bps, floors at the quoted minimum) and says "prototype" only where a mechanic genuinely is; the APY "is prototype data, not a yield claim"; weights "fixed per class" in the prototype description.

## Do's and Don'ts

### Do:
- **Do** set every numeral in JetBrains Mono tabular figures (`.num`) and route formatting through the domain formatters — canonical figures with units (`fmtGusd`, `fmtPerHour`), legends fixed at 3 decimals (`fmtUsdLegend`), ledger rows fixed at 4.
- **Do** keep each hue in its quarantine: green for data, amber for function/active/system speech, cyan for the wire/discount/provider prints, red + bright green for direction, deep phosphor for decoration without words.
- **Do** set headings and prose in primary ink (#e6f5ec) and keep the phosphor ramp for data — the Two-Ink Rule is the whole readability hierarchy.
- **Do** pair every movement figure with a sign glyph (▲/▼) and its tone, and scale the 24h table figure with magnitude (≥4% → 15px bold; ≥2% → 13.5px medium).
- **Do** mark active state with reverse video — `.rev` for function activation, `.rev-g` for selection/BUY/MINT, `.rev-d` for SELL/Disconnect — and abnormal rows with hatch + tag + lamp.
- **Do** number function panels ("01 PRICE CHART" … "07 UNDERLYING GPU") and let the title sit on the top rule with the filler hairline continuing the stroke.
- **Do** keep the Index visually distinct: cyan, labeled, unit-bearing where space allows, always a step below the market figure beside it.
- **Do** speak the canonical vocabulary (Markets, Trade, Recent trades, Index feed, Premium/Discount, Connect) and title markets as pairs (`H100 / gUSD`).
- **Do** pick type sizes from the documented ramp (8–34px, frontmatter `typography.scale`); the clusters are micro tags 8–9.5px, slugs 10–10.5px, data/asides 11–14px, identity figures 15–17px, heroes 20–34px.
- **Do** hide mobile task cells at the grid-item level (`cellVis`) and panels within shared cells per-panel (`vis`) — an empty visible grid item paints a phantom gap row.

### Don't:
- **Don't** round a corner, cast a shadow, or add an icon — zero radius, zero shadow, zero icon glyphs anywhere, scrollbar thumbs included.
- **Don't** introduce gray, achromatic text, or a second font family — headings print in primary ink, data in the phosphor ramp, all one mono face.
- **Don't** spend a hue outside its role — no amber market figures, no cyan function labels, no green panel titles, no red errors.
- **Don't** use banned shorthand — Vol, Liq, Prem, Disc, Issue, Wire (as an Index label), session — anywhere in UI copy; the terminology table is the contract.
- **Don't** carry movement with color alone — an un-glyphed green or red number violates the Direction Rule; never encode abnormality with the hatch alone.
- **Don't** style the Index like the market price or merge them — no candles on the wire, no cyan on market figures, no green Index.
- **Don't** let a cell flash on first render, or flash a move color on an Index figure — wire figures flash cyan.
- **Don't** use a second background tone to band states on one surface — selection is reverse video; hover is deep panel.
- **Don't** add a type size outside the ramp; if a new size is truly needed, add it to the scale deliberately, not as a one-off.
- **Don't** scatter demo confessions — "simulated", "prototype feed", "no venue involved" as ambient copy is a defect; the status line admits once, PROTOTYPE tags mark unresolved concepts only.
- **Don't** invent a metric the oracle doesn't publish — no fabricated latency figures, epoch counters, or coverage percentages; an honest `—` or an updated-age beats a plausible number.
- **Don't** carry forward the retired worlds: the gray-glass function terminal (blue command ink #5c9dff, Spline Sans Mono/Archivo, #131722 glass) and its predecessor — their inks, faces (VT323, B612 Mono), and tokens are retired evidence. Also retired: the EARN/VLT split surfaces and their eight-code nav (`MKT TERM IDX DAT EARN VLT PFL PTC`) — replaced 2026-09-05 by seven full-name keys and the unified gUSD section (`/earn` and `/vaults` redirect).
- **Don't** use "token" language in UI copy; the vocabulary is markets, positions, the wire, units.
