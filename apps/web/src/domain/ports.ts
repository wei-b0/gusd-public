/**
 * Application ports — the seams where the product shell meets infrastructure.
 *
 * The UI consumes these interfaces exclusively. During the product-shell phase
 * they are wired to the mock adapters in src/data/mock; later the same
 * interfaces are implemented by real Index/oracle feeds, the market data
 * indexer, the trading stack (wallet + Uniswap v4 + gUSD hooks), and Privy —
 * without the product UX changing.
 */

import type {
  Account,
  AssetId,
  DepositAssetId,
  ChartRange,
  EarnReceipt,
  EarnState,
  Market,
  MarketSnapshot,
  MarketTrade,
  MintQuote,
  MintReceipt,
  TradeReceipt,
  TradeRequest,
  TradeSide,
} from "./types";

export interface MarketDataPort {
  /** All GPU asset markets, ordered by traded volume. */
  listMarkets(): Market[];
  /** Full snapshot for one market, or null for an unknown asset. */
  getSnapshot(asset: AssetId, range?: ChartRange): MarketSnapshot | null;
  /** Recent prints for one market, oldest first. */
  getRecentTrades(asset: AssetId): MarketTrade[];
  /**
   * Live tick subscription. Callback receives the current market summaries;
   * snapshots are immutable and versioned.
   */
  subscribe(listener: (markets: Market[]) => void): () => void;
}

export interface Quote {
  asset: AssetId;
  side: TradeSide;
  size: number;
  /** Expected gUSD per unit, including expected price impact. */
  price: number;
  /** gUSD in/out including estimated fee. */
  notional: number;
  feeUsd: number;
  /** Prototype-only estimate; real routing arrives with the protocol. */
  priceImpactPct: number;
}

export interface TradingPort {
  getAccount(): Account;
  quote(request: TradeRequest): Quote | null;
  /**
   * Prototype execution: simulates a fill locally and never broadcasts a
   * transaction. Replaced by wallet + Uniswap v4 + gUSD hooks integration.
   */
  execute(request: TradeRequest): Promise<TradeReceipt>;
  /** This session's simulated fills, oldest first. */
  getActivity(): TradeReceipt[];
  subscribe(listener: (account: Account) => void): () => void;
}

/**
 * The earning layer — deploying gUSD into sGUSD. Rates are prototype data
 * until the protocol's yield mechanics land; the seam stays identical.
 */
export interface EarnPort {
  getEarnState(): EarnState;
  /** Move gUSD into the earning layer; returns the prototype receipt. */
  deposit(gUsd: number): Promise<EarnReceipt>;
  /** Return earning capital to gUSD at the current rate. */
  withdraw(gUsd: number): Promise<EarnReceipt>;
  subscribe(listener: (state: EarnState) => void): () => void;
}

/**
 * The mint layer — deposit assets → protocol issuance → gUSD. The real
 * issuance mechanism (deposit catalogue, collateral rules, underwriting,
 * fees, constraints) is not finalized; the port models only the flow a user
 * sees, and the prototype previews at a 1:1 placeholder rate.
 */
export interface MintPort {
  /** Expected issuance for a deposit amount. */
  quote(depositAsset: DepositAssetId, amount: number): MintQuote | null;
  /** Deposit into the issuance mechanism and receive minted gUSD. */
  mint(depositAsset: DepositAssetId, amount: number): Promise<MintReceipt>;
  /** This session's mint receipts, oldest first. */
  getActivity(): MintReceipt[];
  subscribe(listener: () => void): () => void;
}

/** Authentication and wallet abstraction. Privy lives behind this seam. */
export interface AuthPort {
  /** Prototype connect: links a demo identity with demo capital. */
  connect(): Promise<Account>;
  disconnect(): void;
}

export interface Services {
  marketData: MarketDataPort;
  trading: TradingPort;
  auth: AuthPort;
  earn: EarnPort;
  mint: MintPort;
}
