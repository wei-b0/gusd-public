/**
 * Mock adapters implementing the application ports.
 *
 * One coherent prototype world: deterministic generated market data, a local
 * tick loop, simulated fills, and a prototype session. Everything here is
 * clearly labeled infrastructure for the shell phase — replacing this module
 * with real feeds (Index/oracle, market indexer, wallet + Uniswap v4 + gUSD
 * hooks, Privy) is the integration path, and it happens behind the ports in
 * src/domain/ports.
 */

import type { AuthPort, EarnPort, MarketDataPort, MintPort, TradingPort } from "@/domain/ports";
import type { Quote } from "@/domain/ports";
import type {
  Account,
  AssetId,
  ChartRange,
  DepositAssetId,
  EarnReceipt,
  EarnState,
  Market,
  MarketSnapshot,
  MarketTrade,
  MintQuote,
  MintReceipt,
  TradeReceipt,
  TradeRequest,
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

/** Fee the prototype charges on simulated fills, basis points. */
const PROTOTYPE_FEE_BPS = 6;
const FILL_LATENCY_MS = 850;
const TICK_MS = 1_800;
const EARN_LATENCY_MS = 500;

interface WorldState {
  version: number;
  updatedAt: number;
  prices: Record<AssetId, number>;
  indexPrices: Record<AssetId, number>;
  volumes: Record<AssetId, number>;
  tradesByAsset: Record<AssetId, MarketTrade[]>;
  account: Account;
  receipts: TradeReceipt[];
  /** Earn layer: sGUSD→gUSD rate and session accrual. */
  earnRate: number;
  accruedUsd: number;
}

const SEED_POSITIONS = [
  { asset: "H100" as const, size: 6.4, avgEntry: 2.468 },
  { asset: "B200" as const, size: 2.0, avgEntry: 4.351 },
  { asset: "A100" as const, size: 18.0, avgEntry: 1.435 },
];

/**
 * Seed activity consistent with the seeded positions: the session's demo
 * capital already acquired them. Prototype history, clearly simulated.
 */
function seedReceipts(): TradeReceipt[] {
  const t0 = SESSION_ANCHOR - 26 * 3_600_000;
  return [
    { asset: "H100", side: "buy", size: 6.4, fillPrice: 2.468, notional: 6.4 * 2.468 * 1.0006, feeUsd: (6.4 * 2.468 * 6) / 10_000, t: t0 },
    { asset: "B200", side: "buy", size: 2.0, fillPrice: 4.351, notional: 2.0 * 4.351 * 1.0006, feeUsd: (2.0 * 4.351 * 6) / 10_000, t: t0 + 4 * 3_600_000 },
    { asset: "A100", side: "buy", size: 18.0, fillPrice: 1.435, notional: 18.0 * 1.435 * 1.0006, feeUsd: (18.0 * 1.435 * 6) / 10_000, t: t0 + 9 * 3_600_000 },
  ];
}

function initialWorld(): WorldState {
  const prices = {} as Record<AssetId, number>;
  const indexPrices = {} as Record<AssetId, number>;
  const volumes = {} as Record<AssetId, number>;
  const tradesByAsset = {} as Record<AssetId, MarketTrade[]>;
  for (const id of ASSET_IDS) {
    const m = buildMarket(id);
    prices[id] = m.marketPrice;
    indexPrices[id] = m.indexPrice;
    volumes[id] = m.volume24hUsd;
    tradesByAsset[id] = buildRecentTrades(id);
  }
  return {
    version: 0,
    updatedAt: SESSION_ANCHOR,
    prices,
    indexPrices,
    volumes,
    tradesByAsset,
    account: {
      connected: false,
      label: null,
      gUsdBalance: 0,
      sGUsdBalance: 0,
      // Seeded prototype positions so the Sell side is demonstrable.
      positions: SEED_POSITIONS,
    },
    receipts: seedReceipts(),
    earnRate: 1.00052,
    accruedUsd: 0,
  };
}

function quoteFor(request: TradeRequest, price: number): Quote | null {
  if (!price || request.size <= 0) return null;
  // Prototype impact model: ~3 bps per unit up to 25, no real routing.
  const impact = 0.0003 * Math.min(request.size, 25);
  const fillPrice = request.side === "buy" ? price * (1 + impact) : price * (1 - impact);
  const fee = (request.size * fillPrice * PROTOTYPE_FEE_BPS) / 10_000;
  // A buy pays the fee; a sell receives its proceeds net of it.
  const notional = request.side === "buy" ? request.size * fillPrice + fee : request.size * fillPrice - fee;
  return {
    asset: request.asset,
    side: request.side,
    size: request.size,
    price: fillPrice,
    notional,
    feeUsd: fee,
    priceImpactPct: impact * 100,
  };
}

function applyFill(account: Account, receipt: TradeReceipt): Account {
  if (receipt.side === "buy") {
    const existing = account.positions.find((p) => p.asset === receipt.asset);
    const positions = existing
      ? account.positions.map((p) =>
          p.asset === receipt.asset
            ? {
                asset: p.asset,
                size: p.size + receipt.size,
                avgEntry:
                  (p.avgEntry * p.size + receipt.fillPrice * receipt.size) / (p.size + receipt.size),
              }
            : p,
        )
      : [...account.positions, { asset: receipt.asset, size: receipt.size, avgEntry: receipt.fillPrice }];
    return { ...account, gUsdBalance: account.gUsdBalance - receipt.notional, positions };
  }
  const positions = account.positions
    .map((p) => (p.asset === receipt.asset ? { ...p, size: p.size - receipt.size } : p))
    .filter((p) => p.size > 1e-9);
  return { ...account, gUsdBalance: account.gUsdBalance + receipt.notional, positions };
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

  constructor() {
    const world = { state: initialWorld() };
    this.marketData = new MarketDataPortImpl(world);
    this.trading = new TradingPortImpl(world);
    this.auth = new AuthPortImpl(world, this.trading);
    this.earn = new EarnPortImpl(world);
    this.mint = new MintPortImpl(world, this.trading);
    // Live earn accrual rides the market tick loop, and the earn port
    // re-syncs when the account connects or disconnects.
    this.marketData.tickHooks.push(() => this.earn.accrue());
    this.trading.subscribe(() => {
      this.earn.syncAccount();
    });
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

  getSnapshot(asset: AssetId, range: ChartRange = "1D"): MarketSnapshot | null {
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
        epoch: 48_213,
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
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

class TradingPortImpl {
  private listeners = new Set<(account: Account) => void>();

  constructor(private world: { state: WorldState }) {}

  getAccount(): Account {
    return this.world.state.account;
  }

  /** This session's simulated fills, oldest first. */
  getActivity(): TradeReceipt[] {
    return this.world.state.receipts;
  }

  quote(request: TradeRequest): Quote | null {
    return quoteFor(request, this.priceOf(request.asset));
  }

  async execute(request: TradeRequest): Promise<TradeReceipt> {
    await delay(FILL_LATENCY_MS);
    const price = this.priceOf(request.asset);
    const fee = (request.size * price * PROTOTYPE_FEE_BPS) / 10_000;
    const receipt: TradeReceipt = {
      asset: request.asset,
      side: request.side,
      size: request.size,
      fillPrice: price,
      notional:
        request.side === "buy" ? request.size * price + fee : request.size * price - fee,
      feeUsd: fee,
      t: Date.now(),
    };
    this.world.state = {
      ...this.world.state,
      account: applyFill(this.world.state.account, receipt),
      receipts: [...this.world.state.receipts, receipt].slice(-20),
    };
    for (const listener of this.listeners) listener(this.world.state.account);
    return receipt;
  }

  subscribe(listener: (account: Account) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Connect the prototype session and fund it with demo capital. */
  async connectDemo(): Promise<Account> {
    await delay(600);
    const account: Account = {
      connected: true,
      label: "demo-01",
      gUsdBalance: 25_000,
      sGUsdBalance: 8_000,
      positions: SEED_POSITIONS,
    };
    this.world.state = { ...this.world.state, account };
    for (const listener of this.listeners) listener(account);
    return account;
  }

  disconnect(): void {
    const account: Account = {
      connected: false,
      label: null,
      gUsdBalance: 0,
      sGUsdBalance: 0,
      positions: [],
    };
    this.world.state = { ...this.world.state, account };
    for (const listener of this.listeners) listener(account);
  }

  private priceOf(asset: AssetId): number {
    return this.world.state.prices[asset] ?? 0;
  }

  /** Broadcasts an externally mutated account (the mint layer) to listeners. */
  notifyAccount(): void {
    for (const listener of this.listeners) listener(this.world.state.account);
  }
}

class AuthPortImpl {
  constructor(
    private world: { state: WorldState },
    private trading: TradingPortImpl,
  ) {}

  /** Prototype connect: opens a labeled session. No wallet involved. */
  async connect(): Promise<Account> {
    return this.trading.connectDemo();
  }

  disconnect(): void {
    this.trading.disconnect();
  }
}

/** Trailing 30d earning rate — prototype data, not a real yield claim. */
const TRAILING_APY_PCT = 4.18;

/**
 * The earning layer mock: gUSD ↔ sGUSD at a slowly accruing rate. Balances
 * live on the shared account, so trading and earning see one wallet truth.
 * State is cached so useSyncExternalStore gets a stable reference between
 * changes.
 */
class EarnPortImpl {
  private listeners = new Set<(state: EarnState) => void>();
  private cached: EarnState | null = null;
  private receipts: EarnReceipt[] = [];

  constructor(private world: { state: WorldState }) {}

  getEarnState(): EarnState {
    if (!this.cached) this.cached = this.build();
    return this.cached;
  }

  async deposit(gUsd: number): Promise<EarnReceipt> {
    await delay(EARN_LATENCY_MS);
    const account = this.world.state.account;
    if (!account.connected || !Number.isFinite(gUsd) || gUsd <= 0 || gUsd > account.gUsdBalance) {
      throw new Error("Deposit rejected — check the session and the amount.");
    }
    const rate = this.world.state.earnRate;
    const sGUsdMoved = gUsd / rate;
    const receipt: EarnReceipt = { kind: "deposit", gUsdMoved: gUsd, sGUsdMoved, rate, t: Date.now() };
    this.world.state = {
      ...this.world.state,
      account: { ...account, gUsdBalance: account.gUsdBalance - gUsd, sGUsdBalance: account.sGUsdBalance + sGUsdMoved },
    };
    this.bump(receipt);
    return receipt;
  }

  async withdraw(gUsd: number): Promise<EarnReceipt> {
    await delay(EARN_LATENCY_MS);
    const account = this.world.state.account;
    const rate = this.world.state.earnRate;
    const sGUsdMoved = gUsd / rate;
    if (!account.connected || !Number.isFinite(gUsd) || gUsd <= 0 || sGUsdMoved > account.sGUsdBalance) {
      throw new Error("Withdrawal rejected — check the earning balance and the amount.");
    }
    const receipt: EarnReceipt = { kind: "withdraw", gUsdMoved: gUsd, sGUsdMoved, rate, t: Date.now() };
    this.world.state = {
      ...this.world.state,
      account: { ...account, gUsdBalance: account.gUsdBalance + gUsd, sGUsdBalance: account.sGUsdBalance - sGUsdMoved },
    };
    this.bump(receipt);
    return receipt;
  }

  subscribe(listener: (state: EarnState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** One tick of earning accrual on the session's sGUSD. */
  accrue(): void {
    const state = this.world.state;
    if (!state.account.connected || state.account.sGUsdBalance <= 0) return;
    const ticksPerYear = (365 * 24 * 3_600_000) / TICK_MS;
    const perTick = (state.account.sGUsdBalance * state.earnRate * (TRAILING_APY_PCT / 100)) / ticksPerYear;
    this.world.state = { ...state, accruedUsd: state.accruedUsd + perTick };
    this.bump();
  }

  private build(): EarnState {
    const { account, earnRate, accruedUsd, updatedAt } = this.world.state;
    return {
      connected: account.connected,
      availableUsd: account.gUsdBalance,
      sGUsd: account.sGUsdBalance,
      sGUsdValueUsd: account.sGUsdBalance * earnRate,
      rate: earnRate,
      trailingApyPct: TRAILING_APY_PCT,
      accruedUsd,
      receipts: this.receipts,
      updatedAt,
    };
  }

  /** Re-sync when the account connects or disconnects. */
  syncAccount(): void {
    this.bump();
  }

  private bump(receipt?: EarnReceipt): void {
    if (receipt) this.receipts = [...this.receipts, receipt].slice(-12);
    this.cached = this.build();
    for (const listener of this.listeners) listener(this.cached);
  }
}

/**
 * Mint mock: previews the issuance flow — deposit a supported asset into the
 * protocol's issuance mechanism and receive minted gUSD. Deposit assets are
 * placeholders and the rate is a 1:1 prototype preview; the real mechanism
 * (collateral, underwriting, fees, constraints) is not finalized and is not
 * implied here.
 */
class MintPortImpl {
  private listeners = new Set<() => void>();
  private receipts: MintReceipt[] = [];

  constructor(
    private world: { state: WorldState },
    private trading: TradingPortImpl,
  ) {}

  quote(depositAsset: DepositAssetId, amount: number): MintQuote | null {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return { depositAsset, amount, gUsd: amount };
  }

  async mint(depositAsset: DepositAssetId, amount: number): Promise<MintReceipt> {
    await delay(EARN_LATENCY_MS);
    const account = this.world.state.account;
    if (!account.connected || !Number.isFinite(amount) || amount <= 0) {
      throw new Error("Mint rejected — connect, then enter a deposit amount.");
    }
    this.world.state = {
      ...this.world.state,
      account: { ...account, gUsdBalance: account.gUsdBalance + amount },
    };
    this.trading.notifyAccount();
    const receipt: MintReceipt = { depositAsset, amount, gUsdMoved: amount, t: Date.now() };
    this.bump(receipt);
    return receipt;
  }

  /** This session's mint receipts, oldest first. */
  getActivity(): MintReceipt[] {
    return this.receipts;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private bump(receipt?: MintReceipt): void {
    if (receipt) this.receipts = [...this.receipts, receipt].slice(-12);
    for (const listener of this.listeners) listener();
  }
}
