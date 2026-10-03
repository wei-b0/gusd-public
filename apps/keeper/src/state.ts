/**
 * The keeper's state source: a DIRECT read of the Envio indexer's Postgres
 * entities (the compose posture runs the keeper inside the DB's network).
 * The whole book — every market, position, pending order — loads in three
 * queries; the RPC never sees a position poll. Chain rewrites these rows
 * only at order creation/execution and position touches, exactly the
 * granularity the execution strategy needs.
 *
 * The handler mirror of these columns: apps/indexer/src/handlers/perp.ts.
 * Envio names tables verbatim per entity ("PerpPosition") and snake_cases
 * field names; int8 columns arrive as strings in node-postgres, so every
 * numeric read goes through a defensive parse.
 */
import { Pool } from "pg";

export interface KeeperMarket {
  gpuId: string; // bytes32 hex, lowercase
  enabled: boolean;
  maxLeverageBps: bigint;
  maintenanceMarginBps: bigint;
  openFeeBps: bigint;
  closeFeeBps: bigint;
  liquidationFeeBps: bigint;
  fundingRatePpmPerSec: bigint;
  borrowRatePpmPerSec: bigint;
  maxOiUsd: bigint;
  minCollateralUsd: bigint;
  maxPositionUsd: bigint;
  openNotionalLong: bigint;
  openNotionalShort: bigint;
  fundingChargePerUnitLong: bigint;
  fundingChargePerUnitShort: bigint;
  fundingCreditPerUnitLong: bigint;
  fundingCreditPerUnitShort: bigint;
  borrowChargePerUnit: bigint;
  fundingUpdatedAtSec: bigint;
}

export interface KeeperPosition {
  wallet: string; // lowercase address
  gpuId: string; // bytes32 hex
  isLong: boolean;
  sizeUsd: bigint;
  collateral: bigint;
  entryPrice: bigint; // 4-dec
  fundingFeeCheckpoint: bigint;
  fundingCreditCheckpoint: bigint;
  borrowCheckpoint: bigint;
  /** Carried earned-funding credits — folds into the offline equity exactly
   *  like the engine's gate (PerpLiquidation's balanceTotal term). */
  earnedFunding: bigint;
  lastTouchedAtSec: bigint;
}

export interface KeeperOrder {
  orderId: bigint;
  account: string; // lowercase address
  kind: number; // 0 MarketIncrease, 1 MarketDecrease, 2 StopLoss, 3 TakeProfit
  isLong: boolean;
  sizeDeltaUsd: bigint; // 0 on a decrease = close the whole position
  collateralDeltaUsd: bigint;
  acceptablePrice: bigint; // 4-dec; 0 on triggers
  triggerPrice: bigint; // 4-dec; 0 on market orders
  executionFee: bigint;
  createdAtSec: bigint;
  market: string; // bytes32 hex
}

export function positionKey(wallet: string, gpuId: string, isLong: boolean): string {
  return `${wallet}|${gpuId}|${isLong}`;
}

/** One PerpOrder entity row → a KeeperOrder. The entity's market key is the
 *  `gpu_id` column (the handler writes `gpuId`); reading anything else
 *  silently unmatches every order in the strategy's market filter. */
export function orderFromRow(r: Record<string, unknown>): KeeperOrder {
  return {
    orderId: big(r.order_id),
    account: String(r.account),
    kind: toNum(r.kind),
    isLong: r.is_long === true,
    sizeDeltaUsd: big(r.size_delta_usd),
    collateralDeltaUsd: big(r.collateral_delta_usd),
    acceptablePrice: big(r.acceptable_price),
    triggerPrice: big(r.trigger_price),
    executionFee: big(r.execution_fee),
    createdAtSec: big(r.created_at_sec),
    market: String(r.gpu_id),
  };
}

function big(v: unknown): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  return BigInt(String(v));
}

export function toNum(v: unknown): number {
  return Number(big(v));
}

const SCHEMA_RE = /^[A-Za-z0-9_]+$/;

export class Book {
  readonly markets = new Map<string, KeeperMarket>();
  readonly positions = new Map<string, KeeperPosition>();
  readonly orders = new Map<string, KeeperOrder>();
  /** Bumped on every full reload — re-evaluations key off it (see strategy). */
  generation = 0;
  lastLoadedAt = 0;

  constructor(
    private readonly pool: Pool,
    private readonly schema: string,
    private readonly chainId: number,
  ) {
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`INDEXER_SCHEMA must be [A-Za-z0-9_]+, got "${schema}"`);
    }
  }

  private table(name: string): string {
    return `"${this.schema}"."${name}"`;
  }

  /** Full book load — boot and the periodic safety-net reload. */
  async load(): Promise<void> {
    const c = await this.pool.connect();
    try {
      const chainId = this.chainId;
      const markets = await c.query(`SELECT * FROM ${this.table("PerpMarket")} WHERE chain_id = $1`, [chainId]);
      const positions = await c.query(
        `SELECT * FROM ${this.table("PerpPosition")} WHERE chain_id = $1 AND size_usd > 0`,
        [chainId],
      );
      const orders = await c.query(`SELECT * FROM ${this.table("PerpOrder")} WHERE chain_id = $1 AND status = 1`, [
        chainId,
      ]);
      const nextMarkets = new Map<string, KeeperMarket>();
      for (const r of markets.rows) nextMarkets.set(String(r.gpu_id), this.market(r));
      const nextPositions = new Map<string, KeeperPosition>();
      for (const r of positions.rows) {
        const p = this.position(r);
        nextPositions.set(positionKey(p.wallet, p.gpuId, p.isLong), p);
      }
      const nextOrders = new Map<string, KeeperOrder>();
      for (const r of orders.rows) {
        const o = this.order(r);
        nextOrders.set(String(o.orderId), o);
      }
      this.markets.clear();
      this.positions.clear();
      this.orders.clear();
      for (const [k, v] of nextMarkets) this.markets.set(k, v);
      for (const [k, v] of nextPositions) this.positions.set(k, v);
      for (const [k, v] of nextOrders) this.orders.set(k, v);
      this.generation++;
      this.lastLoadedAt = Date.now();
    } finally {
      c.release();
    }
  }

  /** Re-reads one pending order after an execution receipt; drops it from the
   *  cache once the indexer row shows it resolved. */
  async refreshOrder(orderId: bigint): Promise<void> {
    const c = await this.pool.connect();
    try {
      const res = await c.query(`SELECT * FROM ${this.table("PerpOrder")} WHERE chain_id = $1 AND order_id = $2`, [
        this.chainId,
        toNum(orderId),
      ]);
      const row = res.rows[0];
      if (!row || toNum(row.status) !== 1) {
        this.orders.delete(String(orderId));
        return;
      }
      this.orders.set(String(orderId), this.order(row));
    } finally {
      c.release();
    }
  }

  /** Re-reads a wallet's two position rows for one market after an execution
   *  receipt; inserts/updates/deletes the cache entries to match. */
  async refreshPositions(wallet: string, gpuId: string): Promise<void> {
    const c = await this.pool.connect();
    try {
      const res = await c.query(
        `SELECT * FROM ${this.table("PerpPosition")} WHERE chain_id = $1 AND wallet = $2 AND gpu_id = $3`,
        [this.chainId, wallet.toLowerCase(), gpuId],
      );
      for (const isLong of [true, false]) {
        const row = res.rows.find((r: Record<string, unknown>) => r.is_long === isLong);
        const key = positionKey(wallet, gpuId, isLong);
        if (!row || big(row.size_usd) === 0n) {
          this.positions.delete(key);
        } else {
          const p = this.position(row);
          this.positions.set(key, p);
        }
      }
    } finally {
      c.release();
    }
  }

  /** Re-reads one market's cumulatives (a funding touch elsewhere changed them). */
  async refreshMarket(gpuId: string): Promise<void> {
    const c = await this.pool.connect();
    try {
      const res = await c.query(`SELECT * FROM ${this.table("PerpMarket")} WHERE chain_id = $1 AND gpu_id = $2`, [
        this.chainId,
        gpuId,
      ]);
      if (res.rows[0]) this.markets.set(gpuId, this.market(res.rows[0]));
    } finally {
      c.release();
    }
  }

  private market(r: Record<string, unknown>): KeeperMarket {
    return {
      gpuId: String(r.gpu_id),
      enabled: r.enabled === true,
      maxLeverageBps: big(r.max_leverage_bps),
      maintenanceMarginBps: big(r.maintenance_margin_bps),
      openFeeBps: big(r.open_fee_bps),
      closeFeeBps: big(r.close_fee_bps),
      liquidationFeeBps: big(r.liquidation_fee_bps),
      fundingRatePpmPerSec: big(r.funding_rate_ppm_per_sec),
      borrowRatePpmPerSec: big(r.borrow_rate_ppm_per_sec),
      maxOiUsd: big(r.max_oi_usd),
      minCollateralUsd: big(r.min_collateral_usd),
      maxPositionUsd: big(r.max_position_usd),
      openNotionalLong: big(r.open_notional_long),
      openNotionalShort: big(r.open_notional_short),
      fundingChargePerUnitLong: big(r.funding_charge_per_unit_long),
      fundingChargePerUnitShort: big(r.funding_charge_per_unit_short),
      fundingCreditPerUnitLong: big(r.funding_credit_per_unit_long),
      fundingCreditPerUnitShort: big(r.funding_credit_per_unit_short),
      borrowChargePerUnit: big(r.borrow_charge_per_unit),
      fundingUpdatedAtSec: big(r.funding_updated_at_sec),
    };
  }

  private position(r: Record<string, unknown>): KeeperPosition {
    return {
      wallet: String(r.wallet),
      gpuId: String(r.gpu_id),
      isLong: r.is_long === true,
      sizeUsd: big(r.size_usd),
      collateral: big(r.collateral),
      entryPrice: big(r.entry_price),
      fundingFeeCheckpoint: big(r.funding_fee_checkpoint),
      fundingCreditCheckpoint: big(r.funding_credit_checkpoint),
      borrowCheckpoint: big(r.borrow_checkpoint),
      earnedFunding: big(r.earned_funding),
      lastTouchedAtSec: big(r.last_touched_at_sec),
    };
  }

  private order(r: Record<string, unknown>): KeeperOrder {
    return orderFromRow(r);
  }
}

export async function openPool(databaseUrl: string): Promise<Pool> {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  await pool.query("SELECT 1");
  return pool;
}