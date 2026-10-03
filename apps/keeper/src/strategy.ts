/**
 * The tick evaluator: candidate price in → work items out. Pure and local —
 * it touches neither the RPC (the attestation is fetched later, only when
 * work exists) nor the DB beyond the in-memory book.
 */
import { encodeGpuId } from "@gusd/attestor-client";
import {
  advanceFunding,
  acceptablePriceMet,
  isLiquidatable,
  scalePrice,
  settle,
  triggerMet,
  type MarketFunding,
  type PositionFunding,
} from "./math.js";
import type { Book } from "./state.js";

/** The slice of the oracle's CandidateDto the strategy reads. */
export interface CandidateTick {
  gpuId: string; // SKU string, e.g. "H100_SXM_80GB"
  price: number | null; // USD/GPU-hour
  status: string;
  calcHash: string;
}

export type WorkItem =
  | { type: "executeOrder"; orderId: bigint; wallet: string; sku: string; gpuId: string; reason: string }
  | { type: "liquidate"; wallet: string; gpuId: string; isLong: boolean; sku: string; reason: string };

export const KIND_MARKET_INCREASE = 0;
export const KIND_MARKET_DECREASE = 1;
export const KIND_STOP_LOSS = 2;
export const KIND_TAKE_PROFIT = 3;

/**
 * Evaluates one candidate tick against the book. Liquidations come first
 * (risk reduction outranks fee collection); orders then in id order.
 *
 * `nowSec` is the chain clock approximation (see main.ts) — a slightly-early
 * execution attempt is harmless: the engine reverts OrderDelayPending and
 * the sim abort leaves the order pending for the next tick.
 */
export function evaluateTick(
  book: Book,
  minOrderDelaySec: bigint,
  tick: CandidateTick,
  nowSec: bigint,
): WorkItem[] {
  if (tick.price === null || !Number.isFinite(tick.price)) return [];
  const gpuId = encodeGpuId(tick.gpuId).toLowerCase();
  const price = scalePrice(tick.price);
  const market = book.markets.get(gpuId);
  if (!market) return [];

  const items: WorkItem[] = [];

  for (const order of [...book.orders.values()].sort((a, b) => Number(a.orderId - b.orderId))) {
    if (order.market !== gpuId) continue;
    if (nowSec < order.createdAtSec + minOrderDelaySec) continue;
    let ok = false;
    let reason = "";
    if (order.kind === KIND_MARKET_INCREASE) {
      if (!market.enabled) continue; // engine reverts MarketDisabled; wait
      ok = acceptablePriceMet(order.isLong, true, price, order.acceptablePrice);
      reason = ok ? "increase within acceptable price" : "";
    } else if (order.kind === KIND_MARKET_DECREASE) {
      ok = acceptablePriceMet(order.isLong, false, price, order.acceptablePrice);
      reason = ok ? "decrease within acceptable price" : "";
    } else if (order.kind === KIND_STOP_LOSS || order.kind === KIND_TAKE_PROFIT) {
      const kind = order.kind === KIND_STOP_LOSS ? "StopLoss" : "TakeProfit";
      ok = triggerMet(kind, order.isLong, price, order.triggerPrice);
      reason = ok ? `${kind} triggered at ${price}` : "";
    }
    if (ok) {
      items.push({
        type: "executeOrder",
        orderId: order.orderId,
        wallet: order.account,
        sku: tick.gpuId,
        gpuId,
        reason,
      });
    }
  }

  if (market.maintenanceMarginBps === 0n) return items; // defensive zero-params fallback row

  const adv = advanceFunding(market satisfies MarketFunding, nowSec);
  for (const pos of book.positions.values()) {
    if (pos.gpuId !== gpuId) continue;
    const p: PositionFunding = {
      sizeUsd: pos.sizeUsd,
      collateral: pos.collateral,
      entryPrice: pos.entryPrice,
      fundingFeeCheckpoint: pos.fundingFeeCheckpoint,
      fundingCreditCheckpoint: pos.fundingCreditCheckpoint,
      borrowCheckpoint: pos.borrowCheckpoint,
      earnedFunding: pos.earnedFunding,
      isLong: pos.isLong,
    };
    const s = settle(market, adv, p);
    if (isLiquidatable(p, s, price, market.maintenanceMarginBps)) {
      items.push({
        type: "liquidate",
        wallet: pos.wallet,
        gpuId,
        isLong: pos.isLong,
        sku: tick.gpuId,
        reason: "equity below maintenance (offline funding math)",
      });
    }
  }

  // Liquidations outrank fee collection.
  return items.sort((a, b) => (a.type === b.type ? 0 : a.type === "liquidate" ? -1 : 1));
}