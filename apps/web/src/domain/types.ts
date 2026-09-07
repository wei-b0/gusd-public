/**
 * Domain model for the gUSD web product.
 *
 * These types are the product's vocabulary. UI components consume them (and
 * the ports in ./ports) — never a data source. Mock implementations live in
 * src/data/mock; real Index/oracle, market, and protocol integrations replace
 * them behind the same interfaces.
 */

/** viem is the app's chain vocabulary; its types may cross the domain seam. */
import type { Hex, WalletClient, Address } from "viem";

/** GPU asset classes traded on gUSD. Product language: the bare GPU name. */
export type AssetId = "H100" | "H200" | "B200" | "B300" | "GB200" | "GB300" | "A100";

export const ASSET_IDS = ["H100", "H200", "B200", "B300", "GB200", "GB300", "A100"] as const;

/** Parses a route segment or string into a known AssetId, or null. */
export function parseAssetId(value: string): AssetId | null {
  const upper = value.toUpperCase();
  return (ASSET_IDS as readonly string[]).includes(upper) ? (upper as AssetId) : null;
}

/** Publication state of the Index figure behind a market row. Absent ⇒ the
 *  read comes from the mock data source (the single demo admission lives in
 *  the status line). */
export type IndexStatus = "live" | "stale" | "withheld" | "frozen" | "unavailable";

/** The tradeable market, always shown as a pair: H100 / gUSD. */
export function pairName(id: AssetId | string): string {
  return `${id} / gUSD`;
}

/** The reference benchmark for a class: gUSD H100 Index. */
export function indexName(id: AssetId | string): string {
  return `gUSD ${id} Index`;
}

/**
 * The market's trailing-24h move. With a venue leg it is the venue price's
 * move; without one the benchmark IS the market's price, so its move is the
 * market's. Null when neither source can anchor a 24h comparison — never a
 * fabricated figure.
 */
export function marketMove24h(
  m: Pick<Market, "change24hPct" | "indexChange24hPct">,
): number | null {
  return m.change24hPct ?? m.indexChange24hPct;
}

export interface AssetSpec {
  id: AssetId;
  /** GPU configuration the asset's economics reference. */
  referenceSku: string;
  vendor: "nvidia" | "amd";
  vramGb: number;
  formFactor: string;
  /** One-line positioning of the class within the GPU market. */
  note: string;
}

/** One GPU asset trading against gUSD.
 *
 *  Source doctrine: every displayed GPU price comes from exactly one place —
 *  the API/data layer. Market-layer facts (the venue price, traded volume,
 *  depth) have no API until a market-data feed exists; those fields are null
 *  and the UI prints "—" rather than a simulated stand-in. Only the mock
 *  data source (NEXT_PUBLIC_DATA_SOURCE=mock) fills them, as its confessed
 *  demo universe. On-chain state is never a display source — the chain is
 *  touched only for execution, simulation, wallet state, balances, and
 *  allowances. */
export interface Market {
  asset: AssetSpec;
  /** Last traded market price, gUSD per GPU asset unit. Null when no market
   *  data source exists — never a simulated stand-in. */
  marketPrice: number | null;
  /** Market price change over trailing 24h, percent. Null without a market
   *  data source — never fabricated. */
  change24hPct: number | null;
  /** Market price change over trailing 7d, percent. Null without a market
   *  data source. */
  change7dPct: number | null;
  /** gUSD Index reference price for the underlying GPU-hour, USD/GPU-hour.
   *  The Index comes from exactly one place: for oracle-backed rows this is
   *  the oracle's last asserted publication, and null when it asserts none
   *  (withheld from birth, unreachable, never computed) — never a simulated
   *  stand-in. Only the mock data source fills a simulated number here. */
  indexPrice: number | null;
  /** Index change over trailing 24h, percent. Null when the oracle's history
   *  is too shallow to anchor a 24h comparison — never fabricated. */
  indexChange24hPct: number | null;
  /** Market price relative to Index, percent. Positive = premium. Null when
   *  there is no market price, or when the Index behind it is
   *  withheld/frozen/unavailable — a premium against no reference is
   *  meaningless. */
  basisPct: number | null;
  /**
   * Publication state of the oracle figure behind this row's Index fields.
   * Absent ⇒ the row's Index read is simulated (mock data source; the status
   * line carries the single demo admission). For oracle-backed rows:
   * `live` (fresh candidate), `stale` (last-known, past the freshness gate),
   * `withheld`/`frozen` (oracle refuses to assert a price), `unavailable`
   * (oracle unreachable or never computed — Index prints "—", never a
   * simulated stand-in).
   */
  indexStatus?: IndexStatus;
  /** Publication telemetry for the row's Index series — the oracle's own
   *  fast-moving wire facts (dispersion, confidence band, sources, cadence),
   *  not prices. Null when no oracle series backs the row (mock universe,
   *  oracle unreachable): telemetry is never simulated, only null. */
  indexTelemetry: IndexTelemetry | null;
  /** Trailing-24h traded volume, gUSD. Null without a market data source. */
  volume24hUsd: number | null;
  /** Depth available across the market's pools, gUSD. Null without a market
   *  data source. */
  liquidityUsd: number | null;
  /** Recent closes for the register sparkline — market closes when a market
   *  layer exists; otherwise the Index's own last closes (real prints). */
  sparkline: number[];
}

export interface Candle {
  /** Unix ms. */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface IndexPoint {
  t: number;
  value: number;
}

export type TradeSide = "buy" | "sell";

export interface MarketTrade {
  id: string;
  side: TradeSide;
  size: number;
  price: number;
  /** gUSD notation. */
  notional: number;
  t: number;
}

/** One provider observation feeding the Index. Fields the oracle does not
 *  publish stay null and render as "—" — never fabricated. */
export interface ProviderObservation {
  id: string;
  provider: string;
  /** Normalized observed price, USD per GPU-hour. */
  priceUsdPerGpuHour: number | null;
  /** Share of the Index weight for this GPU class, percent. */
  weightPct: number | null;
  /** Observation coverage over the panel window, percent. Null when
   *  unpublished (the oracle carries sample sizes, not coverage). */
  coveragePct: number | null;
  /** Unix ms of the provider's latest observation. */
  lastObservedAt: number | null;
  status: "live" | "delayed" | "stale";
}

/** The oracle's own fast-moving wire facts about one benchmark series —
 *  telemetry of the publication process, not prices. Every field comes
 *  straight from the candidate wire; nothing here is derived into a number
 *  the oracle did not print. Absent ⇒ null on the Market, never simulated. */
export interface IndexTelemetry {
  /** Dispersion of the latest panel, USD per GPU-hour (the oracle's own
   *  spread measure across contributing sources). */
  dispersion: number | null;
  /** The panel's confidence band, USD per GPU-hour. Null when withheld. */
  confidenceLow: number | null;
  confidenceHigh: number | null;
  /** Sources observed / actually contributing in the latest panel. */
  sourcesObserved: number | null;
  sourcesContributing: number | null;
  /** Publications that landed in the trailing hour. Counted from the
   *  candidate history's own computedAt stamps — real landings only. */
  publications1h: number | null;
  /** Unix ms of the latest publication (its computedAt, not local receipt). */
  lastPublishedAt: number | null;
}

export interface IndexQuality {
  /** Providers currently contributing to the panel. */
  sourcesLive: number;
  sourcesTotal: number;
  /** Coverage over the panel window, percent. Null when the source does not
   *  publish coverage — the UI hides the figure rather than inventing one. */
  coveragePct: number | null;
  /** Ingest latency for the latest publication, ms. Null when the source
   *  does not expose it — UI shows the candidate's age instead. */
  latencyMs: number | null;
  /** Publication identity of the latest candidate: the sha256 calcHash
   *  prefix. Null for simulated rows. Replaces the prototype's fabricated
   *  epoch counter — no such counter exists on the wire. */
  publication: string | null;
  updatedAt: number;
}

/** Window statistics for one market. Fields the active data source cannot
 *  serve stay null and render "—" — never fabricated. Trade counts and sizes
 *  have no source until a market-data feed exists; the Index-derived
 *  reference stats (open/high/low) are real when the oracle's history
 *  covers the window. */
export interface MarketStats {
  high24h: number | null;
  low24h: number | null;
  high30d: number | null;
  low30d: number | null;
  open24h: number | null;
  trades24h: number | null;
  avgTradeSize: number | null;
}

export interface MarketSnapshot {
  market: Market;
  candles: Candle[];
  index: IndexPoint[];
  providers: ProviderObservation[];
  recentTrades: MarketTrade[];
  stats: MarketStats;
  /** Publication quality of the latest oracle candidate. Null when the
   *  oracle has published nothing for this class — quality describes a
   *  publication, and inventing an empty one would fabricate freshness. */
  quality: IndexQuality | null;
}

/** Chart candle intervals for the price sheet — grain selectors, the
 *  TradingView idiom. The window each grain fetches is the data layer's
 *  series plan; the label IS the candle grain (1m = one-minute candles). */
export type ChartRange = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "6h" | "12h" | "1d" | "1w";

export const CHART_RANGES: readonly ChartRange[] = [
  "1m", "5m", "15m", "30m", "1h", "4h", "6h", "12h", "1d", "1w",
];

/** Seconds of chart time one candle of a range aggregates. Mirrors the
 *  oracle /candles endpoint's interval allowlist. */
export const RANGE_INTERVAL_SEC: Record<ChartRange, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3_600,
  "4h": 14_400,
  "6h": 21_600,
  "12h": 43_200,
  "1d": 86_400,
  "1w": 604_800,
};

/** Chart time each interval's window spans — sized for 240–365 visible
 *  bars. The data layer's series plan (which windows it fetches) and the
 *  depth notes ("history is shallower than the selected window") both read
 *  this one map. */
export const RANGE_WINDOW_MS: Record<ChartRange, number> = {
  "1m": 6 * 3_600_000,
  "5m": 86_400_000,
  "15m": 3 * 86_400_000,
  "30m": 6 * 86_400_000,
  "1h": 14 * 86_400_000,
  "4h": 40 * 86_400_000,
  "6h": 60 * 86_400_000,
  "12h": 120 * 86_400_000,
  "1d": 365 * 86_400_000,
  "1w": 730 * 86_400_000,
};

export interface Position {
  asset: AssetId;
  size: number;
  /**
   * gUSD cost basis per unit. Null when no source asserts one — the chain
   * has no cost-basis view pre-indexer, and printing 0 would fabricate the
   * figure every P&L row leans on. UI renders "—".
   */
  avgEntry: number | null;
  /**
   * Realized PnL from the indexer's protocol-attributable basis (gUSD).
   * Null unless the basis is complete — same gate as avgEntry.
   */
  realizedPnl: number | null;
  /**
   * Why the basis is gated (the indexer's `reason`, verbatim), when
   * realizedPnl/avgEntry are null. Feeds the "—" tooltip; null otherwise.
   */
  basisReason: string | null;
}

export interface Account {
  connected: boolean;
  /** Connection label shown in the shell; never a wallet address claim. */
  label: string | null;
  /**
   * The account's one wallet address (0x…, mixed case as the wallet reports
   * it), or null when the session has no wallet — the prototype session.
   * Comparison sites normalize case; display goes through fmtAddress.
   */
  address: string | null;
  gUsdBalance: number;
  sGUsdBalance: number;
  /** The chain's reserve asset — gUSD's underlying, the mint desk's home asset. */
  stableBalance: number;
  positions: Position[];
}

/* ---------------------------------------------------------------------------
 * Identity, wallet, and transaction infrastructure — the domain vocabulary
 * for the auth/wallet layer. The auth adapter (Privy) and the transaction
 * port produce these; UI renders them. One user = one wallet: every type
 * here describes exactly one wallet per session, with no selection,
 * switching, or secondary-wallet state anywhere in the vocabulary.
 * ------------------------------------------------------------------------- */

/** Where the signer came from. Display metadata only — protocol surfaces
 *  never branch on it; every wallet speaks the same EIP-1193 provider shape. */
export type WalletKind = "embedded" | "external";

/** Identity pushed into the (still demo-capital) account by the auth bridge. */
export interface SessionIdentity {
  label: string | null;
  address: string | null;
}

/** Sync state of the session's identity against the backend boundary. */
export type SessionSyncState = "idle" | "synced" | "failed" | "expired";

/** Why a session ended on its own. `user` = the user disconnected. */
export type SessionClosedReason = "user" | "wallet-changed" | "expired" | null;

/** The connected identity and its one wallet. `status: "idle"` is the
 *  disconnected state (frozen constant; hydration-safe). `address` may lag
 *  `status: "connected"` while the wallet resolves (embedded provisioning). */
export interface WalletSession {
  status: "idle" | "connecting" | "connected";
  /** Privy user DID (did:privy:…). Null when unauthenticated. */
  did: string | null;
  /** The user's wallet address, or null until the wallet resolves. */
  address: string | null;
  /** Where the wallet came from. Null while unknown; display metadata only. */
  walletKind: WalletKind | null;
  /** Human wallet-client name (e.g. "MetaMask"). Null when unknown. */
  walletLabel: string | null;
  /** CAIP-2 chain id the wallet reports (eip155:…), or null. */
  chainId: string | null;
  /** True when the wallet is on the app's active chain. Null while unknown. */
  networkOk: boolean | null;
  /** Backend identity sync state (see SessionSyncState). */
  syncState: SessionSyncState;
  closedReason: SessionClosedReason;
}

/**
 * Which step of a connect interaction the adapter is in; the connect dialog
 * is a view of this. Non-closed steps carry the error slot the dialog's
 * amber voice renders, and busy states render as pending slugs.
 */
export type ConnectFlow =
  | { step: "closed" }
  | { step: "method"; error: string | null }
  /** Email code sent; `email` is shown back, `busy` while verifying/resending. */
  | { step: "email"; email: string; busy: boolean; error: string | null }
  /** OAuth is in flight — a redirect for google; the flow resumes on return. */
  | { step: "oauth"; provider: "google"; error: string | null }
  /** Awaiting the external wallet itself (extension prompt, WC handshake). */
  | { step: "wallet"; walletLabel: string | null; error: string | null }
  /** Awaiting the SIWE signature the wallet was asked to sign. */
  | { step: "signature"; walletLabel: string | null; error: string | null }
  /** Privy is creating the embedded wallet for a Web2 login. */
  | { step: "provisioning"; error: string | null }
  /** The flow died; message is product-voiced, never a raw error string. */
  | { step: "error"; message: string };

/**
 * A user's instruction to the connect flow's state machine. The connect
 * dialog (and any other connect surface) emits these through
 * AuthPort.flowAction; the adapter owns every transition. Actions carry only
 * what the user typed or picked — identity itself always comes from verified
 * tokens, never from the flow.
 */
export type ConnectAction =
  | { type: "submit-email"; email: string }
  | { type: "submit-code"; code: string }
  | { type: "resend-code" }
  | { type: "back-to-method" }
  | { type: "choose-google" }
  | { type: "choose-wallet"; walletId: string };

/** A wallet this environment offers for external connection. `id` is the
 *  adapter's product key ("metamask", "rabby", "injected", …); `label` is
 *  the display name the wallet itself announced. */
export interface ConnectableWallet {
  id: string;
  label: string;
}

/** Lifecycle of a chain transaction the app drove. */
export type TxStatus =
  | "signing"
  | "rejected"
  | "submitting"
  | "pending"
  | "confirmed"
  | "reverted"
  | "failed";

/** One chain transaction, session-local. Never a portfolio/history source —
 *  the tx port records only what this app drove this session. */
export interface TxRecord {
  id: string;
  /** Transaction hash once submitted; null before that. */
  hash: string | null;
  status: TxStatus;
  /** Product surface that initiated it (e.g. "trade", "earn", "mint"). */
  origin: string;
  /** What the transaction does, in product vocabulary (e.g. "transfer"). */
  kind: string;
  /** Chain the transaction was bound to. */
  chainId: number;
  /** Signer address. */
  address: string | null;
  createdAt: number;
  updatedAt: number;
  /** Unix ms when the receipt landed (confirmed or reverted). */
  settledAt: number | null;
  /** Block number once included (confirmed or reverted). */
  blockNumber: number | null;
  /** Product-voiced failure reason for rejected/reverted/failed; else null. */
  error: string | null;
}

/**
 * A transaction the app wants on-chain. `execute` receives the viem wallet
 * client for the active chain and performs the actual signing/sending; the
 * transaction port wraps it with the lifecycle, receipt tracking, and state
 * the UI renders. The returned hash enters the pending → settled half.
 */
export interface TxSpec {
  origin: string;
  kind: string;
  execute(wallet: WalletClient): Promise<{ hash: Hex }>;
}

export interface TradeRequest {
  asset: AssetId;
  side: TradeSide;
  size: number;
  /**
   * Slippage tolerance, bps — buys sign `maxPaid` (quote × (1 + tol)),
   * sells sign `minOut` (quote × (1 − tol)). Default 50 (0.5%).
   */
  toleranceBps?: number;
}

/** Fees one leg actually incurs, gUSD. A pool leg's LP fee rides inside the
 *  swap's own all-in price — observable there, not decomposable pre-trade —
 *  so only the hook's protocol take is broken out. */
export interface PoolLegFees {
  /** The hook's protocol trading fee on the gUSD leg. */
  protocol: number;
}

export interface IssuanceLegFees {
  /** Primary issuance fee on this leg. */
  issuance: number;
}

/**
 * One execution leg. `gUsd` is what the leg moves: cost for a buy leg,
 * net proceeds for a sell leg. The frontend derives SOURCE and fee copy
 * from the leg set — never from static market metadata — so the slip can
 * never display a fee this particular quote does not incur.
 */
export type TradeLeg =
  | { kind: "pool"; gpuUnits: number; gUsd: number; fees: PoolLegFees }
  | { kind: "issuance"; gpuUnits: number; gUsd: number; fees: IssuanceLegFees };

export type TradeLegKind = TradeLeg["kind"];

/** Units one kind of leg fills across a quote (buys split, sells pool-only). */
export function legUnits(quote: TradeQuote, kind: TradeLegKind): number {
  return quote.legs.reduce((sum, leg) => (leg.kind === kind ? sum + leg.gpuUnits : sum), 0);
}

/** Total fees this quote's legs actually incur, gUSD. */
export function quoteFees(quote: TradeQuote): number {
  return quote.legs.reduce(
    (sum, leg) => sum + ("protocol" in leg.fees ? leg.fees.protocol : leg.fees.issuance),
    0,
  );
}

/**
 * One trade quote — the execution stack the order signs against: the
 * router's own quoteIssue for the issuance leg, the hook-aware V4Quoter
 * for the pool leg. Quote and execution run the same protocol pricing
 * path and math; the fill is bounded by the user's signed limits — buys
 * are exact-out (`maxPaid` is the gUSD spend cap the router pulls and
 * refunds from), sells are exact-in (`minOut` is the payout floor). All
 * gUSD figures are product units.
 */
export interface TradeQuote {
  asset: AssetId;
  side: TradeSide;
  size: number;
  /** Effective gUSD per unit — buys: quote total / size; sells: net proceeds / size. */
  price: number;
  /** gUSD total pre-tolerance: spend for buys, proceeds for sells. */
  notional: number;
  /** Buys: the signed spend cap — notional × (1 + tolerance). */
  maxPaid: number;
  /** Sells: the signed payout floor — notional × (1 − tolerance). */
  minOut: number;
  /** The execution legs this quote priced, in fill order. */
  legs: readonly TradeLeg[];
  /** Tolerance the cap/floor carry, bps. */
  toleranceBps: number;
  /** Wall-clock the quote was computed at — the stale-quote guard's clock. */
  quotedAtMs: number;
  /** Head block the quote priced at. */
  blockNumber: number | null;
}

/**
 * Onchain availability of one market — the slip's gate. The port returns
 * null when the GPU has no settlement panel registered at all. Pool
 * registration with zero depth is still "registered": the quote layer says
 * whether depth exists.
 */
export interface TradeAvailability {
  issuanceEnabled: boolean;
  poolRegistered: boolean;
  /** The pool's LP fee, bps (part of the desk's fee schedule). */
  poolFeeBps: number;
  /** The hook's protocol trading fee, bps. */
  hookFeeBps: number;
  /** This market's primary issuance fee, bps. */
  issuanceFeeBps: number;
}

export interface TradeReceipt {
  asset: AssetId;
  side: TradeSide;
  size: number;
  /** gUSD per unit. */
  fillPrice: number;
  /** gUSD moved, including fee. */
  notional: number;
  feeUsd: number;
  t: number;
}

/* ---------------------------------------------------------------------------
 * Earning layer — gUSD into sGUSD through the sgUSD vault.
 *
 * The vault is a fee-free ERC-4626 over gUSD: deposit mints shares at the
 * current share price, withdraw burns shares for assets. The share price is
 * the yield — there is no APY source onchain, so none is displayed. The
 * port's previews are the contract's own (execution-identical); balances
 * live in the onchain account store, receipts in the session action ledger.
 * ------------------------------------------------------------------------- */

/** Which way the earn desk moves capital. */
export type EarnDirection = "stake" | "unstake";

/** Live public state of the earning layer — the vault's share price and
 *  seed gate. Null figures mean "not read yet", not zero. */
export interface EarnState {
  /** gUSD per 1 sgUSD at the current share price (product units). */
  rate: number | null;
  /** False until the vault holds its seed deposit — deposits refuse. */
  seeded: boolean | null;
  /** Wall-clock the snapshot was read at; null before the first read. */
  updatedAt: number | null;
}

/** One execution-identical vault preview. The desk's input is always
 *  denominated in gUSD (assets); shares are what moves. */
export interface EarnQuote {
  direction: EarnDirection;
  /** gUSD the desk input. */
  input: number;
  /** sgUSD minted (stake) or burned (unstake). */
  shares: number;
}

/* ---------------------------------------------------------------------------
 * Mint layer — the chain's reserve asset ⇄ gUSD (plus whitelisted funding
 * stables routed through the StableRouter).
 *
 * The reserve asset enters through GUSD.mint (in, gUSD out net of the mint
 * fee) and leaves through GUSD.redeem (gUSD burned, reserve out net of the
 * redeem fee). A funding stable that is NOT the reserve asset rides the
 * StableRouter: v4 swap to the reserve, then the same mint (reverse on
 * redeem). Previews are execution-identical, so a preview IS the quote.
 * Session receipts live in the tx store; the chain's events own history.
 * ------------------------------------------------------------------------- */

/** One side of the mint desk: mint (stable in → gUSD out) or redeem (gUSD in
 *  → stable out). */
export type MintDirection = "mint" | "redeem";

/** An execution-identical preview from the contract, in product units. */
export interface MintQuote {
  direction: MintDirection;
  /** The funding stable this quote is denominated in — the reserve asset
   *  itself or a StableRouter-whitelisted stable. Identity comes from the
   *  deployment record, never from token symbols. */
  asset: Address;
  /** Input amount — the stable for mint, gUSD for redeem. */
  input: number;
  /** Output after the fee — gUSD for mint, the stable for redeem. */
  output: number;
  /** The mint/redeem fee, in reserve-asset (gUSD-equivalent) units. The
   *  reserve-asset path charges exactly this; via a swap path the swap's
   *  pool fee additionally sits inside the conversion (bounded by the
   *  caller's slippage clip, reflected in `output`). */
  fee: number;
  /** The contract's current fee rate, bps. */
  feeBps: number;
  /** True when the protocol operator paused this flow. */
  paused: boolean;
  /** True when `asset` is not the reserve asset — the quote's conversion
   *  rides a v4 swap leg (and the action rides the StableRouter). */
  viaSwap: boolean;
  /** The signed swap floor for `viaSwap` quotes — what execution guarantees
   *  at minimum (gUSD for mints, the funding stable for redemptions).
   *  Null on the reserve-asset path, where the preview itself is exact. */
  minOutput: number | null;
}
