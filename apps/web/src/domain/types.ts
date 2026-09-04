/**
 * Domain model for the gUSD web product.
 *
 * These types are the product's vocabulary. UI components consume them (and
 * the ports in ./ports) — never a data source. Mock implementations live in
 * src/data/mock; real Index/oracle, market, and protocol integrations replace
 * them behind the same interfaces.
 */

/** GPU asset classes traded on gUSD. Product language: the bare GPU name. */
export type AssetId = "H100" | "H200" | "B200" | "B300" | "GB200" | "GB300" | "A100";

export const ASSET_IDS = ["H100", "H200", "B200", "B300", "GB200", "GB300", "A100"] as const;

/** Parses a route segment or string into a known AssetId, or null. */
export function parseAssetId(value: string): AssetId | null {
  const upper = value.toUpperCase();
  return (ASSET_IDS as readonly string[]).includes(upper) ? (upper as AssetId) : null;
}

/** The tradeable market, always shown as a pair: H100 / gUSD. */
export function pairName(id: AssetId | string): string {
  return `${id} / gUSD`;
}

/** The reference benchmark for a class: gUSD H100 Index. */
export function indexName(id: AssetId | string): string {
  return `gUSD ${id} Index`;
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

/** One GPU asset trading against gUSD. */
export interface Market {
  asset: AssetSpec;
  /** Last traded market price, gUSD per GPU asset unit. */
  marketPrice: number;
  /** Market price change over trailing 24h, percent. */
  change24hPct: number;
  /** Market price change over trailing 7d, percent. */
  change7dPct: number;
  /** gUSD Index reference price for the underlying GPU-hour, gUSD. */
  indexPrice: number;
  /** Index change over trailing 24h, percent. */
  indexChange24hPct: number;
  /** Market price relative to Index, percent. Positive = premium. */
  basisPct: number;
  /** Trailing-24h traded volume, gUSD. */
  volume24hUsd: number;
  /** Depth available across the market's pools, gUSD. */
  liquidityUsd: number;
  /** Recent closes for the register sparkline. */
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

/** One provider observation feeding the Index. */
export interface ProviderObservation {
  id: string;
  provider: string;
  /** Normalized observed price, USD per GPU-hour. */
  priceUsdPerGpuHour: number;
  /** Share of the Index weight for this GPU class, percent. */
  weightPct: number;
  /** Observation coverage over the panel window, percent. */
  coveragePct: number;
  /** Unix ms of the provider's latest observation. */
  lastObservedAt: number;
  status: "live" | "delayed" | "stale";
}

export interface IndexQuality {
  /** Providers currently contributing to the panel. */
  sourcesLive: number;
  sourcesTotal: number;
  coveragePct: number;
  /** Ingest latency for the latest epoch, ms. */
  latencyMs: number;
  /** Oracle epoch counter for the latest publication. */
  epoch: number;
  updatedAt: number;
}

export interface MarketStats {
  high24h: number;
  low24h: number;
  high30d: number;
  low30d: number;
  open24h: number;
  trades24h: number;
  avgTradeSize: number;
}

export interface MarketSnapshot {
  market: Market;
  candles: Candle[];
  index: IndexPoint[];
  providers: ProviderObservation[];
  recentTrades: MarketTrade[];
  stats: MarketStats;
  quality: IndexQuality;
}

/** Chart time windows for the price sheet. */
export type ChartRange = "1D" | "1W" | "1M" | "3M";

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
  gUsdBalance: number;
  sGUsdBalance: number;
  positions: Position[];
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
