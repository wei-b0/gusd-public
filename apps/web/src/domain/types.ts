/**
 * Domain model for the gUSD web product.
 *
 * These types are the product's vocabulary. UI components consume them (and
 * the ports in ./ports) — never a data source. Mock implementations live in
 * src/data/mock; real Index/oracle, market, and protocol integrations replace
 * them behind the same interfaces.
 */

/** viem is the app's chain vocabulary; its types may cross the domain seam. */
import type { Hex, WalletClient } from "viem";

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
export type ChartRange = "1m" | "5m" | "15m" | "30m" | "6h" | "12h" | "1d" | "1w";

export const CHART_RANGES: readonly ChartRange[] = [
  "1m", "5m", "15m", "30m", "6h", "12h", "1d", "1w",
];

/** Seconds of chart time one candle of a range aggregates. Mirrors the
 *  oracle /candles endpoint's interval allowlist. */
export const RANGE_INTERVAL_SEC: Record<ChartRange, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
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
  "6h": 60 * 86_400_000,
  "12h": 120 * 86_400_000,
  "1d": 365 * 86_400_000,
  "1w": 730 * 86_400_000,
};

export interface Position {
  asset: AssetId;
  size: number;
  /** gUSD cost basis per unit. */
  avgEntry: number;
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
 * Earning layer — gUSD into sGUSD.
 *
 * The exact yield sources and protocol revenue routing are not finalized;
 * every rate here is prototype data. The port exists so the real earning
 * adapter can replace the mock without the UX changing.
 * ------------------------------------------------------------------------- */

/** Live state of the earning layer for the current session. */
export interface EarnState {
  connected: boolean;
  /** gUSD available to deploy. */
  availableUsd: number;
  /** Earning balance, sGUSD units. */
  sGUsd: number;
  /** Earning balance valued in gUSD at the current rate. */
  sGUsdValueUsd: number;
  /** sGUSD → gUSD conversion rate. */
  rate: number;
  /** Trailing 30d annualized earning rate, percent. Prototype data. */
  trailingApyPct: number;
  /** Earnings accrued this session, gUSD. */
  accruedUsd: number;
  /** Recent earn receipts for this session, newest last. */
  receipts: EarnReceipt[];
  updatedAt: number;
}

export interface EarnReceipt {
  kind: "deposit" | "withdraw";
  /** gUSD moved. */
  gUsdMoved: number;
  /** sGUSD moved. */
  sGUsdMoved: number;
  /** Rate applied at execution. */
  rate: number;
  t: number;
}

/* ---------------------------------------------------------------------------
 * Mint layer — deposit assets → protocol issuance → gUSD.
 *
 * The conceptual flow: a user deposits a supported asset into the protocol's
 * issuance mechanism and receives minted gUSD. The real mechanism — which
 * assets are supported, collateral rules, underwriting, fees, issuance
 * constraints — is not finalized and is not invented here. The port models
 * only the user-visible shape of that flow (choose asset, amount, expected
 * gUSD, transaction information, receipt) so the real adapter can replace
 * the prototype without the UX changing. The prototype previews at a 1:1
 * placeholder rate and says so.
 * ------------------------------------------------------------------------- */

/** Placeholder ids for supported deposit assets. The real catalogue is still
 *  being specified, so the UI keeps these deliberately generic. */
export type DepositAssetId = "A" | "B" | "C";

export const DEPOSIT_ASSET_IDS: readonly DepositAssetId[] = ["A", "B", "C"];

/** Display label for a placeholder deposit asset — "Asset A". */
export function depositAssetName(id: DepositAssetId): string {
  return `Asset ${id}`;
}

export interface MintQuote {
  depositAsset: DepositAssetId;
  amount: number;
  /** Expected gUSD minted. */
  gUsd: number;
}

export interface MintReceipt {
  depositAsset: DepositAssetId;
  amount: number;
  /** gUSD minted. */
  gUsdMoved: number;
  t: number;
}
