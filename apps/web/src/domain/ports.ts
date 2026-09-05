/**
 * Application ports — the seams where the product shell meets infrastructure.
 *
 * The UI consumes these interfaces exclusively. During the product-shell phase
 * they are wired to the mock adapters in src/data/mock; later the same
 * interfaces are implemented by real Index/oracle feeds, the market data
 * indexer, the trading stack (wallet + Uniswap v4 + gUSD hooks), and Privy —
 * without the product UX changing.
 */

import type { WalletClient, Hex } from "viem";
import type {
  Account,
  AssetId,
  ConnectAction,
  ConnectableWallet,
  ConnectFlow,
  DepositAssetId,
  ChartRange,
  EarnReceipt,
  EarnState,
  Market,
  MarketSnapshot,
  MarketTrade,
  MintQuote,
  MintReceipt,
  SessionIdentity,
  TradeReceipt,
  TradeRequest,
  TradeSide,
  TxRecord,
  TxSpec,
  WalletSession,
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
  /**
   * Adopt a real identity into the account — the auth bridge's channel for
   * pushing the authenticated user's wallet into the (still demo-capital)
   * account. Null ends the session. Adapter-internal concern: product code
   * never calls this; it reads the account through getAccount/subscribe.
   */
  adoptSession(identity: SessionIdentity | null): void;
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

/**
 * Authentication and wallet abstraction. Privy lives behind this seam, and
 * so does every wallet origin: embedded (Web2 logins) and external (Web3
 * logins) normalize to one session with one signer. viem types are the
 * app's chain vocabulary and may cross this seam; Privy's may not.
 */
export interface AuthPort {
  /**
   * Open the connect flow — the in-world connect dialog. Resolves once the
   * flow is open (or, in demo mode, once the prototype session connects);
   * it never blocks UI on authentication itself.
   */
  connect(): Promise<void>;
  /** Close the connect flow without authenticating. */
  cancelConnect(): void;
  /**
   * Drive the connect flow's state machine — the dialog's channel for every
   * in-flow instruction (submit an email, pick a wallet, go back). No-op in
   * demo mode, where no flow ever opens.
   */
  flowAction(action: ConnectAction): void;
  /** Wallets this environment offers for external connection. */
  listConnectableWallets(): ConnectableWallet[];
  /** End the session and reset wallet/transaction state. */
  disconnect(): void;
  /** Current connect-flow step; the dialog is a view of it. */
  getConnectFlow(): ConnectFlow;
  subscribeConnectFlow(listener: (flow: ConnectFlow) => void): () => void;
  /** The session snapshot — frozen references between changes. */
  getSession(): WalletSession;
  subscribeSession(listener: (session: WalletSession) => void): () => void;
  /**
   * A viem WalletClient bound to the user's wallet on `chainId`, for signing
   * and writes. Rejects without a session, while the wallet is unresolved,
   * or when the wallet sits on a different chain (fix that via switchChain).
   */
  getWalletClient(chainId: number): Promise<WalletClient>;
  /** Ask the wallet to switch to `chainId`, adding it if the wallet lacks it. */
  switchChain(chainId: number): Promise<void>;
}

/**
 * The transaction seam — the single entry for every future protocol write.
 * The port owns the lifecycle (signing → submitting → pending → settled);
 * a spec's `execute` does the actual signing/sending with the wallet client
 * it receives. Records are session-local: never a portfolio or history
 * source — the chain's events own that.
 */
export interface TxPort {
  /** This session's transactions, newest first (frozen references). */
  list(): readonly TxRecord[];
  get(id: string): TxRecord | null;
  subscribe(listener: () => void): () => void;
  /**
   * Drive one transaction through the full lifecycle. Rejects before any
   * signature is requested when there is no session or the wallet is on the
   * wrong network; terminal states (rejected/reverted/failed) resolve to
   * their record rather than throwing.
   */
  run(spec: TxSpec): Promise<TxRecord>;
  /** Clear session records (logout). */
  clear(): void;
}

export interface Services {
  marketData: MarketDataPort;
  trading: TradingPort;
  auth: AuthPort;
  earn: EarnPort;
  mint: MintPort;
  tx: TxPort;
}
