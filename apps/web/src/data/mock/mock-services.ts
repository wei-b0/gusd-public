/**
 * Mock adapters implementing the application ports.
 *
 * One coherent prototype universe for the market-data surface: deterministic
 * generated market data and a local tick loop. That is all that remains —
 * execution has no mock. Trading, earning, and minting are walletless
 * stubs that refuse honestly; the real stack (the onchain ports over the
 * shared action runner) takes those seams over whenever a Privy app id
 * configures the build. The seams live in src/domain/ports.
 */

import type {
  ActionPort,
  AuthPort,
  EarnPort,
  MarketDataPort,
  MintPort,
  TradingPort,
  TxPort,
} from "@/domain/ports";
import type { ActionRecord } from "@/domain/actions";
import type {
  Account,
  AssetId,
  ChartRange,
  ConnectFlow,
  ConnectableWallet,
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
  TxRecord,
  WalletSession,
} from "@/domain/types";
import { ASSET_IDS, parseAssetId } from "@/domain/types";
import {
  SESSION_ANCHOR,
  buildCandles,
  buildIndex,
  buildMarket,
  buildProviders,
  buildRecentTrades,
  buildStats,
} from "./generate";

const TICK_MS = 1_800;

/** The one honest voice a build without wallet support can speak. */
const NO_WALLET = "This build runs without wallet support — nothing can sign here.";

/**
 * Frozen session snapshots for the prototype world. The prototype session
 * has no wallet: address, kind, and chain stay null — the honest shape, not
 * a stand-in for one. Frozen module constants keep useSyncExternalStore's
 * Object.is comparison stable.
 */
const DISCONNECTED_SESSION: WalletSession = {
  status: "idle",
  did: null,
  address: null,
  walletKind: null,
  walletLabel: null,
  chainId: null,
  networkOk: null,
  syncState: "idle",
  closedReason: null,
};

const CONNECTED_SESSION: WalletSession = {
  status: "connected",
  did: "did:mock:demo-01",
  address: null,
  walletKind: null,
  walletLabel: null,
  chainId: null,
  networkOk: null,
  syncState: "idle",
  closedReason: null,
};

/** The one closed flow; connect() resolves without ever opening one. */
const CLOSED_FLOW: ConnectFlow = { step: "closed" };

interface WorldState {
  version: number;
  updatedAt: number;
  prices: Record<AssetId, number>;
  indexPrices: Record<AssetId, number>;
  volumes: Record<AssetId, number>;
  tradesByAsset: Record<AssetId, MarketTrade[]>;
}

function initialWorld(): WorldState {
  const prices = {} as Record<AssetId, number>;
  const indexPrices = {} as Record<AssetId, number>;
  const volumes = {} as Record<AssetId, number>;
  const tradesByAsset = {} as Record<AssetId, MarketTrade[]>;
  for (const id of ASSET_IDS) {
    const m = buildMarket(id);
    // The mock universe fills every market figure — always numbers here.
    prices[id] = m.marketPrice!;
    indexPrices[id] = m.indexPrice!;
    volumes[id] = m.volume24hUsd!;
    tradesByAsset[id] = buildRecentTrades(id);
  }
  return {
    version: 0,
    updatedAt: SESSION_ANCHOR,
    prices,
    indexPrices,
    volumes,
    tradesByAsset,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The complete mock implementation of the application ports. */
export class MockServices {
  marketData: MarketDataPortImpl;
  trading: TradingPortImpl;
  auth: AuthPortImpl;
  earn: EarnPortImpl;
  mint: MintPortImpl;
  tx: MockTxPort;
  actions: MockActionPort;

  constructor() {
    const world = { state: initialWorld() };
    this.marketData = new MarketDataPortImpl(world);
    this.trading = new TradingPortImpl();
    this.auth = new AuthPortImpl(this.trading);
    this.earn = new EarnPortImpl();
    this.mint = new MintPortImpl();
    this.tx = new MockTxPort();
    this.actions = new MockActionPort();
  }
}

class MarketDataPortImpl {
  private listeners = new Set<(markets: Market[]) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Extra work per tick (earn accrual, vault drift) wired by MockServices. */
  readonly tickHooks: (() => void)[] = [];

  constructor(private world: { state: WorldState }) {}

  listMarkets(): Market[] {
    const { prices, indexPrices, volumes } = this.world.state;
    return ASSET_IDS.map((id) => {
      const base = buildMarket(id);
      const price = prices[id]!;
      const indexPrice = indexPrices[id]!;
      return {
        ...base,
        marketPrice: price,
        indexPrice,
        basisPct: (price / indexPrice - 1) * 100,
        volume24hUsd: volumes[id]!,
      };
    }).sort((a, b) => b.volume24hUsd - a.volume24hUsd);
  }

  getSnapshot(asset: AssetId, range: ChartRange = "5m"): MarketSnapshot | null {
    if (!parseAssetId(asset)) return null;
    const providers = buildProviders(asset);
    const market = this.listMarkets().find((m) => m.asset.id === asset)!;
    return {
      market,
      candles: buildCandles(asset, range),
      index: buildIndex(asset, range),
      providers,
      recentTrades: this.world.state.tradesByAsset[asset] ?? [],
      stats: buildStats(asset),
      quality: {
        sourcesLive: providers.filter((p) => p.status === "live").length,
        sourcesTotal: 10,
        coveragePct: 97.8,
        latencyMs: 412,
        // Simulated rows have no publication identity — the UI renders "—".
        publication: null,
        updatedAt: this.world.state.updatedAt,
      },
    };
  }

  /** Recent prints for one market, oldest first — the live tape. */
  getRecentTrades(asset: AssetId): MarketTrade[] {
    if (!parseAssetId(asset)) return [];
    return this.world.state.tradesByAsset[asset] ?? [];
  }

  subscribe(listener: (markets: Market[]) => void): () => void {
    this.listeners.add(listener);
    this.ensureTicking();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopTicking();
    };
  }

  /** One simulated tick: both series drift, the tape prints, volume accrues. */
  tick(): void {
    const state = this.world.state;
    for (const id of ASSET_IDS) {
      const price = state.prices[id]!;
      const index = state.indexPrices[id]!;
      const priceNext = price * (1 + (Math.random() - 0.5) * 0.0011);
      const indexNext = index * (1 + (Math.random() - 0.5) * 0.00012);
      state.prices[id] = priceNext;
      state.indexPrices[id] = indexNext;
      state.volumes[id] = state.volumes[id]! + Math.abs(priceNext - price) * 900;
      const tape = state.tradesByAsset[id]!;
      if (Math.random() < 0.65) {
        const size = [0.5, 1, 2, 2.5, 4, 5, 8, 12][Math.floor(Math.random() * 8)]!;
        const side: MarketTrade["side"] = Math.random() < 0.52 ? "buy" : "sell";
        tape.push({
          id: `${id}-tick-${state.version}`,
          side,
          size,
          price: priceNext,
          notional: size * priceNext,
          t: Date.now(),
        });
        if (tape.length > 40) tape.shift();
      }
    }
    this.world.state = {
      ...state,
      version: state.version + 1,
      updatedAt: Date.now(),
    };
    for (const hook of this.tickHooks) hook();
    const markets = this.listMarkets();
    for (const listener of this.listeners) listener(markets);
  }

  private ensureTicking(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopTicking(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * The walletless trading port — no quotes, no availability, no fills, no
 * positions beyond the disconnected zero. Acting refuses with the build's
 * one honest voice; nothing here simulates an order.
 */
class TradingPortImpl {
  private listeners = new Set<(account: Account) => void>();
  private account: Account = {
    connected: false,
    label: null,
    address: null,
    gUsdBalance: 0,
    sGUsdBalance: 0,
    usdcBalance: 0,
    positions: [],
  };

  getAccount(): Account {
    return this.account;
  }

  async describeAsset(): Promise<TradeAvailability | null> {
    return null;
  }

  async quote(_request: TradeRequest): Promise<TradeQuote | null> {
    return null;
  }

  async execute(): Promise<never> {
    throw new Error(NO_WALLET);
  }

  subscribe(listener: (account: Account) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Connect the prototype session — an identity only, never a wallet. */
  async connectDemo(): Promise<Account> {
    await delay(600);
    this.setAccount({ ...this.account, connected: true, label: "demo-01" });
    return this.account;
  }

  disconnect(): void {
    this.setAccount({
      connected: false,
      label: null,
      address: null,
      gUsdBalance: 0,
      sGUsdBalance: 0,
      usdcBalance: 0,
      positions: [],
    });
  }

  private setAccount(next: Account): void {
    this.account = next;
    for (const listener of this.listeners) listener(next);
  }
}

class AuthPortImpl implements AuthPort {
  private sessionListeners = new Set<(session: WalletSession) => void>();

  constructor(private trading: TradingPortImpl) {
    // The prototype session's wallet state is flat: connected or not.
    this.trading.subscribe(() => {
      const session = this.getSession();
      for (const listener of this.sessionListeners) listener(session);
    });
  }

  /** Prototype connect: links a demo identity. No dialog, no wallet. */
  async connect(): Promise<void> {
    await this.trading.connectDemo();
  }

  /** Nothing opens a flow in the prototype world; nothing to cancel. */
  cancelConnect(): void {}

  /** The prototype never opens a flow, so no action can arrive. */
  flowAction(): void {}

  /** The prototype session has no wallet — there is nothing to list. */
  listConnectableWallets(): ConnectableWallet[] {
    return [];
  }

  disconnect(): void {
    this.trading.disconnect();
  }

  getConnectFlow(): ConnectFlow {
    return CLOSED_FLOW;
  }

  subscribeConnectFlow(): () => void {
    return () => {};
  }

  getSession(): WalletSession {
    return this.trading.getAccount().connected ? CONNECTED_SESSION : DISCONNECTED_SESSION;
  }

  subscribeSession(listener: (session: WalletSession) => void): () => void {
    this.sessionListeners.add(listener);
    return () => {
      this.sessionListeners.delete(listener);
    };
  }

  getWalletClient(): Promise<never> {
    return Promise.reject(new Error(NO_WALLET));
  }

  switchChain(): Promise<void> {
    return Promise.reject(new Error(NO_WALLET));
  }
}

/**
 * The prototype has no chain access: transactions are simply refused rather
 * than simulated. Real writes arrive with the protocol behind the same port.
 */
class MockTxPort implements TxPort {
  list(): readonly TxRecord[] {
    return [];
  }

  get(): TxRecord | null {
    return null;
  }

  subscribe(): () => void {
    return () => {};
  }

  run(): Promise<TxRecord> {
    return Promise.reject(new Error(NO_WALLET));
  }

  clear(): void {}
}

/** No wallet means no action can run; the runner seam exists for parity. */
class MockActionPort implements ActionPort {
  list(): readonly ActionRecord[] {
    return [];
  }

  get(): ActionRecord | null {
    return null;
  }

  subscribe(): () => void {
    return () => {};
  }

  isActionActive(): boolean {
    return false;
  }

  run(): Promise<ActionRecord> {
    return Promise.reject(new Error(NO_WALLET));
  }

  clear(): void {}
}

/**
 * The walletless earning port: the vault's facts stay empty (the desks
 * render "—" rather than an invented rate) and acting refuses.
 */
class EarnPortImpl {
  private listeners = new Set<() => void>();

  getEarnState(): EarnState {
    return { rate: null, seeded: null, updatedAt: null };
  }

  async quote(_direction: EarnDirection, _gUsd: number): Promise<EarnQuote | null> {
    return null;
  }

  async deposit(): Promise<never> {
    throw new Error(NO_WALLET);
  }

  async withdraw(): Promise<never> {
    throw new Error(NO_WALLET);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async refresh(): Promise<void> {}
}

/**
 * The walletless mint port: no previews (the desk renders "—"), acting
 * refuses.
 */
class MintPortImpl {
  async quote(_direction: MintDirection, _amount: number): Promise<MintQuote | null> {
    return null;
  }

  async mint(): Promise<never> {
    throw new Error(NO_WALLET);
  }

  async redeem(): Promise<never> {
    throw new Error(NO_WALLET);
  }
}
