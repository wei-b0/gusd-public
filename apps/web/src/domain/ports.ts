/**
 * Application ports — the seams where the product shell meets infrastructure.
 *
 * The UI consumes these interfaces exclusively. During the product-shell phase
 * they are wired to the mock adapters in src/data/mock; later the same
 * interfaces are implemented by real Index/oracle feeds, the market data
 * indexer, the trading stack (wallet + Uniswap v4 + gUSD hooks), and Privy —
 * without the product UX changing.
 */

import type { WalletClient, Hex, Address } from "viem";
import type { ActionOrigin, ActionRecord, ActionPlan } from "./actions";
import type {
  BridgeOrigin,
  BridgeProgress,
  BridgeQuote,
} from "./bridge";
import type {
  Account,
  AssetId,
  ConnectAction,
  ConnectableWallet,
  ConnectFlow,
  ChartRange,
  EarnDirection,
  EarnQuote,
  EarnState,
  Market,
  MarketSnapshot,
  MarketTrade,
  MintDirection,
  MintQuote,
  TradeAvailability,
  TradeQuote,
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

export interface TradingPort {
  getAccount(): Account;
  /**
   * Onchain availability of one market — the order slip's gate. Null when
   * the asset has no settlement panel registered onchain at all.
   */
  describeAsset(asset: AssetId): Promise<TradeAvailability | null>;
  /**
   * Execution-identical quote from the router stack (quoteIssue + the
   * hook-aware V4Quoter), or null when the request cannot be quoted —
   * unregistered asset, no secondary depth for sells, or an invalid size.
   * Works without a session — quoting is public, acting is not.
   */
  quote(request: TradeRequest): Promise<TradeQuote | null>;
  /**
   * Execute through the action runner (approval + router call +
   * reconciliation). Requires a connected wallet; resolves to the action
   * record the desk renders, including every failure exit.
   */
  execute(request: TradeRequest): Promise<ActionRecord>;
  subscribe(listener: (account: Account) => void): () => void;
}

/**
 * The earning layer — deploying gUSD into sGUSD through the vault. Previews
 * are execution-identical (the contract's own ERC-4626 previews); deposit
 * and withdraw run through the action runner (one gUSD approval for
 * deposits, approval-free withdraws) and resolve to the action record the
 * desk renders. The share price is the yield; there is no APY figure.
 */
export interface EarnPort {
  /** The vault's public facts — share price and seed gate. */
  getEarnState(): EarnState;
  /** Execution-identical vault preview, or null for an invalid amount.
   *  Works without a session — the preview is public, acting is not. */
  quote(direction: EarnDirection, gUsd: number): Promise<EarnQuote | null>;
  /** Move gUSD into the earning layer. Requires a connected wallet. */
  deposit(gUsd: number): Promise<ActionRecord>;
  /** Return earning capital to gUSD. Requires a connected wallet. */
  withdraw(gUsd: number): Promise<ActionRecord>;
  subscribe(listener: () => void): () => void;
  /** Re-read the vault's public facts (the share price can move). */
  refresh(): Promise<void>;
}

/**
 * The mint layer — the chain's reserve asset (and whitelisted stables) ⇄
 * gUSD against the real contracts. Previews are execution-identical
 * (GUSD's own previews on the reserve path; StableRouter flows compose the
 * v4 quote with them); mint and redeem run through the action runner (one
 * approval + one call for mint, approval-free redeem on the reserve path)
 * and resolve to the action record the desk renders. Session history lives
 * in the tx store. `asset` is always a deployment-record address — the
 * whitelist, never a symbol.
 */
export interface MintPort {
  /** Execution-identical preview, or null for an invalid amount. Works
   *  without a session — the preview is public, acting is not. */
  quote(direction: MintDirection, asset: Address, amount: number): Promise<MintQuote | null>;
  /** Mint gUSD from the funding stable. Requires a connected wallet. */
  mint(asset: Address, amount: number): Promise<ActionRecord>;
  /** Redeem gUSD back to the funding stable. Requires a connected wallet. */
  redeem(asset: Address, gusdAmount: number): Promise<ActionRecord>;
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

/**
 * The action seam — one user intent end to end, however many transactions it
 * takes (approval + call + reconciliation). The runner owns the orchestration
 * and the desks render its records; the tx port beneath records each
 * transaction. Records are session-local, like tx records.
 */
export interface ActionPort {
  /** This session's actions, newest first (frozen references). */
  list(): readonly ActionRecord[];
  get(id: string): ActionRecord | null;
  subscribe(listener: () => void): () => void;
  /** True while a non-terminal action sits on this surface — the desks'
   *  duplicate-submit gate. */
  isActionActive(origin: ActionOrigin): boolean;
  /**
   * Drive one plan end to end. Rejects only on the duplicate guard; every
   * product failure resolves to its record rather than throwing.
   */
  run(plan: ActionPlan): Promise<ActionRecord>;
  /** Clear session records (logout). */
  clear(): void;
}

/**
 * The cross-chain funding layer — a third-party bridge aggregator (Across)
 * that lands a stable from a supported origin chain into the wallet on the
 * active chain, ready for the mint desk. The protocol never bridges and the
 * port never mints: its last phase (`mint-ready`) hands off to `MintPort`.
 * Capability-gated by the chain registry — ports on chains without funding
 * capability stay inert.
 */
export interface BridgePort {
  /** Origin chains this bridge serves, with their fundable tokens. */
  origins(): BridgeOrigin[];
  /**
   * Price a bridge of `amount` (product units) of an origin token to the
   * active chain's reserve asset. Null when the route cannot be priced —
   * unknown origin, unsupported token, or the bridge API failed.
   */
  getQuote(originChainId: number, token: Address, amount: number): Promise<BridgeQuote | null>;
  /**
   * Drive the bridge for a quote this port issued. Yields progress through
   * the phases and always terminates (the last yield is `mint-ready` or
   * `failed`). Requires a connected wallet; the wallet may be asked to
   * switch to the origin chain mid-flow.
   */
  execute(quote: BridgeQuote): AsyncIterable<BridgeProgress>;
}

export interface Services {
  marketData: MarketDataPort;
  trading: TradingPort;
  auth: AuthPort;
  earn: EarnPort;
  mint: MintPort;
  bridge: BridgePort;
  tx: TxPort;
  actions: ActionPort;
}
