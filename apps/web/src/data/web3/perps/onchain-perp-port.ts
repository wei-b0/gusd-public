/**
 * The real perp port — gUSD-settled GPU perpetual futures on GpuPerpEngine.
 * Two-stage execution shapes everything here: `createOrder` locks collateral
 * + execution fee but embeds NO report (the keeper's `executeOrder` consumes
 * a fresh attestation later), so a submit's price work is entirely preview —
 * one current attestation prices the acceptable-price bound, one simulation
 * of the exact calldata gates the signature, and there is no report to pin
 * or heal. Position state runs the other doctrine: the raw struct reads
 * attestation-free (existence is always truthful), and the marked figures —
 * uPnL/equity/maintenance — attach only through a verified `getPosition`
 * probe with the live report (never consumes), the GPUIssuance
 * quote-doctrine, so they are exactly what the next execution would
 * recompute; without a current report the desk shows raw figures and says
 * so, it never invents a price.
 *
 * Money discipline mirrors the engine: fees ceil, payouts floor, entries
 * round against the trader (see ./math). Actions ride the shared action
 * runner — the exact-amount approval (collateral + execution fee on opens,
 * the fee alone on closes/triggers), the pre-signature simulation, and
 * reconciliation — and resolve to the action record the desk renders.
 * Settlement is claim-based: decreases/liquidations credit `claimableOf`,
 * `claim()` pays it out of the sgUSD vault (approval-free, possibly partial).
 */

import type { Address } from "viem";
import type { ActionPort, PerpPort } from "@/domain/ports";
import type { ActionPlan, ActionRecord, ApprovalNeed } from "@/domain/actions";
import type {
  AssetId,
  PerpCloseQuote,
  PerpCloseRequest,
  PerpMarketState,
  PerpOpenQuote,
  PerpOpenRequest,
  PerpPendingOrder,
  PerpPositionProbe,
  PerpPositionState,
  PerpSide,
  PerpTriggerRequest,
} from "@/domain/types";
import { fmtGusdLedger, fmtGusdPrecise } from "@/domain/format";
import { formatGusdRaw, parseGusd } from "@/domain/units";
import { fetchAttestation, attestedPrice, type Attestation } from "@/data/oracle/attestation";
import { GPU_PERP_ENGINE_ABI } from "../abis/gpu_perp_engine";
import { getContracts, type PerpEngineContract } from "../contracts";
import { simulateWrite } from "../simulate";
import { planApproval } from "../approvals";
import { assetForGpuId, assetForWireGpuId, gpuIdForAsset } from "../gpu-id";
import { GPU_ID_TO_ASSET } from "@/data/oracle/panel-map";
import { REPORT_BRIDGE_MS, defaultSleep } from "../trading/quotes";
import {
  acceptablePriceBound,
  feeBps,
  fundingEarned,
  fundingOwed,
  leverageBpsCeil,
  liquidationPriceEstimate,
  mulDiv,
  pnl,
  sizeFromCollateral,
  unscalePrice,
} from "./math";
import { PERP_ORDER_KIND, perpCancelSpec, perpClaimSpec, perpCreateOrderSpec } from "./specs";

export interface OnChainPerpPortDeps {
  /** The session source — the port refuses to act without one. */
  getSession(): { status: string; address: string | null };
  actions: ActionPort;
  /** Post-confirmation refresh. */
  reconcile?: (txIds: readonly string[]) => Promise<unknown>;
  /** The attestation fetch — injectable for tests. */
  attestation?(gpuId: `0x${string}`): Promise<Attestation>;
  /** Pacing for the renewal-gap bridge (injectable no-op in tests). */
  sleep?(ms: number): Promise<void>;
  /** Head block for quote snapshots (best-effort). */
  getBlockNumber?(): Promise<number | null>;
}

const NO_SESSION = "Connect a wallet to trade perps — nothing signs without one.";
/** No current-epoch report at quote/submit time — the attestor's liveness,
 *  not the market's. The submit bridge waits one renewal gap out. */
const NO_ATTESTATION =
  "The oracle has no current price report right now — orders wait for the attestor's next attestation. Try again in a moment.";
const NO_WALLET_BALANCE =
  "This wallet doesn't hold the collateral and execution fee this open locks — mint gUSD from the reserve asset first.";
const NO_FEE_BALANCE =
  "This wallet doesn't hold the execution fee this order locks — mint gUSD from the reserve asset first.";

/** The submit-time patience, the trading port's: eight × 600ms ≈ 4.8s of
 *  polling across the attestor's renewal gap before refusing. */
const SUBMIT_BRIDGE_ATTEMPTS = 8;

/** OrderKind → the domain's vocabulary (numeric enum on the engine). */
const KIND_LABEL: Record<number, PerpPendingOrder["kind"]> = {
  0: "open",
  1: "close",
  2: "stop-loss",
  3: "take-profit",
};

/** Signed int256 raw (6-dec gUSD) → display number. */
function toUsdSigned(raw: bigint): number {
  return Number(raw) / 1e6;
}

/** The engine's raw Position struct → the domain's position state with the
 *  marked figures left null — the truthful half of a report-gap read. */
type RawEnginePosition = NonNullable<
  Awaited<ReturnType<PerpEngineContract["read"]["positions"]>>
>;

function rawPosition(asset: AssetId, side: PerpSide, raw: RawEnginePosition): PerpPositionState {
  return {
    asset,
    side,
    sizeUsd: formatGusdRaw(raw.sizeUsd),
    collateral: formatGusdRaw(raw.collateral),
    entryPrice: unscalePrice(raw.entryPrice),
    markPrice: null,
    uPnl: null,
    equity: null,
    maintenance: null,
    liquidatable: null,
    fundingNet: null,
    liquidationPrice: null,
    updatedAt: Date.now(),
    markedAt: null,
  };
}

/** A signed ppm/sec funding rate → a per-second number. */
function ppmPerSec(raw: bigint): number {
  return Number(raw) / 1e6;
}

export class OnChainPerpPort implements PerpPort {
  private readonly deps: OnChainPerpPortDeps;
  /** Order ids this session created — the listPendingOrders fallback when
   *  the indexer is absent (session-local provenance, never a portfolio). */
  private sessionOrderIds: bigint[] = [];

  constructor(deps: OnChainPerpPortDeps) {
    this.deps = deps;
  }

  private engine() {
    return getContracts().perpEngine;
  }

  private attestationFor(gpuId: `0x${string}`): Promise<Attestation> {
    return this.deps.attestation ? this.deps.attestation(gpuId) : fetchAttestation(gpuId);
  }

  private async bridgedAttestation(gpuId: `0x${string}`): Promise<Attestation> {
    const sleep = this.deps.sleep ?? defaultSleep;
    let att = await this.attestationFor(gpuId);
    for (let i = 0; i < SUBMIT_BRIDGE_ATTEMPTS && att.kind !== "current"; ++i) {
      await sleep(REPORT_BRIDGE_MS);
      att = await this.attestationFor(gpuId);
    }
    return att;
  }

  private session(): { owner: Address } | null {
    const s = this.deps.getSession();
    if (s.status !== "connected" || !s.address) return null;
    return { owner: s.address as Address };
  }

  private async blockNumber(): Promise<number | null> {
    try {
      return this.deps.getBlockNumber ? await this.deps.getBlockNumber() : null;
    } catch {
      return null;
    }
  }

  async describeMarket(asset: AssetId): Promise<PerpMarketState | null> {
    const gpuId = gpuIdForAsset(asset);
    try {
      const v = await this.engine().read.getMarket([gpuId]);
      return {
        asset,
        enabled: v.market.enabled,
        maxLeverageBps: Number(v.market.params.maxLeverageBps),
        maintenanceMarginBps: Number(v.market.params.maintenanceMarginBps),
        openFeeBps: Number(v.market.params.openFeeBps),
        closeFeeBps: Number(v.market.params.closeFeeBps),
        liquidationFeeBps: Number(v.market.params.liquidationFeeBps),
        fundingRateLongPpmPerSec: ppmPerSec(v.fundingRateLongPpmPerSec),
        fundingRateShortPpmPerSec: ppmPerSec(v.fundingRateShortPpmPerSec),
        borrowRatePpmPerSec: ppmPerSec(v.borrowRatePpmPerSec),
        openInterestLong: formatGusdRaw(v.market.openNotionalLong),
        openInterestShort: formatGusdRaw(v.market.openNotionalShort),
        maxOiUsd: formatGusdRaw(v.market.params.maxOiUsd),
        minCollateralUsd: formatGusdRaw(v.market.params.minCollateralUsd),
        maxPositionUsd: formatGusdRaw(v.market.params.maxPositionUsd),
        updatedAt: Number(v.market.fundingUpdatedAt) * 1000,
      };
    } catch {
      // UnknownMarket — no perp market for this asset.
      return null;
    }
  }

  async getClaimable(): Promise<number | null> {
    const session = this.session();
    if (!session) return null;
    try {
      return formatGusdRaw(await this.engine().read.claimableOf([session.owner]));
    } catch {
      return null;
    }
  }

  /**
   * One position probe, in two stages. The raw `positions()` read is
   * attestation-free and always truthful about existence — `flat` only
   * when it saw zero size, never on a failure. When a current report is
   * available the verified `getPosition` view attaches the marked figures
   * (uPnL/equity/maintenance at that exact report price); without one the
   * probe returns the raw figures `unmarked` — the desk says so, it never
   * invents a price or collapses an open position into "Flat".
   */
  async getPosition(asset: AssetId, side: PerpSide): Promise<PerpPositionProbe> {
    const session = this.session();
    if (!session) return { kind: "flat" };
    const gpuId = gpuIdForAsset(asset);
    const isLong = side === "long";
    // Stage 1 — the raw struct. Failure here is `unknown`: the position's
    // existence is simply unreadable right now.
    const raw = await this.engine().read.positions([session.owner, gpuId, isLong]).catch(() => null);
    if (raw === null) return { kind: "unknown" };
    if (raw.sizeUsd === 0n) return { kind: "flat" };
    // Stage 2 — the marked figures through a verified report.
    const att = await this.attestationFor(gpuId);
    if (att.kind !== "current") {
      return { kind: "unmarked", position: rawPosition(asset, side, raw) };
    }
    const price = attestedPrice(att);
    if (price === null) {
      return { kind: "unmarked", position: rawPosition(asset, side, raw) };
    }
    try {
      const v = await this.engine().read.getPosition([session.owner, gpuId, isLong, att.updateData]);
      // The position closed between the two reads — the probe saw it settle.
      if (v.position.sizeUsd === 0n) return { kind: "flat" };
      const mmBps = BigInt((await this.engine().read.markets([gpuId])).params.maintenanceMarginBps);
      // fundingDebt ≡ collateral + uPnL − equity = the position's NET accrued
      // funding (owed + borrow − earned credits) — exactly what the
      // estimator wants: a net credit widens the headroom, a net debt
      // narrows it (the engine's equity includes credits since G1).
      const fundingDebt = v.position.collateral + v.uPnL - v.equity;
      const liqPrice = liquidationPriceEstimate(
        v.position.sizeUsd, v.position.collateral, v.position.entryPrice, isLong,
        mmBps, fundingDebt,
      );
      const now = Date.now();
      return {
        kind: "ok",
        position: {
          asset,
          side,
          sizeUsd: formatGusdRaw(v.position.sizeUsd),
          collateral: formatGusdRaw(v.position.collateral),
          entryPrice: unscalePrice(v.position.entryPrice),
          markPrice: unscalePrice(price),
          uPnl: toUsdSigned(v.uPnL),
          equity: toUsdSigned(v.equity),
          maintenance: formatGusdRaw(v.maintenance),
          liquidatable: v.liquidatable,
          fundingNet: toUsdSigned(v.fundingDue),
          liquidationPrice: liqPrice === null ? null : unscalePrice(liqPrice),
          updatedAt: now,
          markedAt: now,
        },
      };
    } catch {
      // The verified view failed (probe revert, market read) — the raw
      // figures stand, the marked ones don't.
      return { kind: "unmarked", position: rawPosition(asset, side, raw) };
    }
  }

  async listPendingOrders(): Promise<PerpPendingOrder[] | null> {
    const session = this.session();
    if (!session) return [];
    const indexed = await fetchIndexedPendingOrders(session.owner);
    if (indexed) return indexed;
    // Fallback: this session's own order ids, read off the engine. The
    // session-provenance doctrine — never a portfolio, just what this
    // session armed. When every read fails the answer is null, never a
    // fabricated empty list.
    const engine = this.engine();
    const out: PerpPendingOrder[] = [];
    let anyFailure = false;
    for (const id of this.sessionOrderIds) {
      try {
        const o = await engine.read.orders([id]);
        if (o.account !== session.owner || o.status !== 1) continue;
        const projected = projectOrder(id, o);
        if (projected) out.push(projected);
      } catch {
        anyFailure = true;
      }
    }
    if (out.length === 0 && anyFailure && this.sessionOrderIds.length > 0) return null;
    return out;
  }

  async quoteOpen(request: PerpOpenRequest): Promise<PerpOpenQuote | null> {
    const gpuId = gpuIdForAsset(request.asset);
    const [att, raw] = await Promise.all([
      this.attestationFor(gpuId),
      this.engine().read.getMarket([gpuId]).catch(() => null),
    ]);
    if (!raw || !raw.market.enabled || att.kind !== "current") return null;
    const price = attestedPrice(att);
    if (price === null || price === 0n) return null;

    const collateralRaw = parseGusd(request.collateral);
    if (collateralRaw <= 0n) return null;
    const leverageBps = BigInt(Math.round(request.leverage * 10_000));
    if (leverageBps <= 0n) return null;
    const sizeRaw = sizeFromCollateral(collateralRaw, leverageBps);
    const params = raw.market.params;
    // The engine's createOrder gates, previewed: leverage ceil, per-position
    // cap, side OI cap, and the min-collateral floor on the RESULTING
    // position — an increase on an existing position counts its collateral
    // (only knowable with a session; a guest preview checks the delta).
    const session = this.session();
    const currentColl = session
      ? ((await this.engine().read.positions([session.owner, gpuId, request.side === "long"]).catch(() => null))
          ?.collateral ?? 0n)
      : 0n;
    const sideOi =
      request.side === "long" ? raw.market.openNotionalLong : raw.market.openNotionalShort;
    if (
      sizeRaw === 0n ||
      leverageBpsCeil(sizeRaw, collateralRaw) > params.maxLeverageBps ||
      sizeRaw > params.maxPositionUsd ||
      sideOi + sizeRaw > params.maxOiUsd ||
      currentColl + collateralRaw < params.minCollateralUsd
    ) {
      return null;
    }

    const executionFee = await this.engine().read.MIN_EXECUTION_FEE();
    return {
      asset: request.asset,
      side: request.side,
      collateral: request.collateral,
      sizeUsd: formatGusdRaw(sizeRaw),
      openFee: formatGusdRaw(feeBps(sizeRaw, BigInt(params.openFeeBps))),
      executionFee: formatGusdRaw(executionFee),
      acceptablePrice: unscalePrice(acceptablePriceBound(price, tolerance(request), request.side === "long", true)),
      referencePrice: unscalePrice(price),
      quotedAtMs: Date.now(),
      blockNumber: await this.blockNumber(),
    };
  }

  async quoteClose(request: PerpCloseRequest): Promise<PerpCloseQuote | null> {
    const session = this.session();
    if (!session) return null;
    const gpuId = gpuIdForAsset(request.asset);
    const att = await this.attestationFor(gpuId);
    if (att.kind !== "current") return null;
    const price = attestedPrice(att);
    if (price === null) return null;
    const view = await this.engine()
      .read.getPosition([session.owner, gpuId, request.side === "long", att.updateData])
      .catch(() => null);
    if (!view || view.position.sizeUsd === 0n) return null;

    // A null size closes whole; a larger one clamps to held (reduceOnly).
    const held = view.position.sizeUsd;
    const sizeRaw = request.size === null ? held : clampRaw(parseGusd(request.size), held);
    if (sizeRaw === 0n) return null;

    const closeFeeBps = BigInt(
      (await this.engine().read.markets([gpuId]).catch(() => null))?.params.closeFeeBps ?? 0,
    );
    // Pro-rata funding attribution — the engine's G2 shape: the closed slice
    // settles only ITS share of the accrued funding (charges ceil, credits
    // floor at the same per-unit deltas the full settlement reads), so the
    // preview mirrors the decrease tranche exactly. The raw position read
    // supplies the checkpoints the verified view doesn't carry.
    const raw = await this.engine().read.positions([session.owner, gpuId, request.side === "long"]);
    const mk = await this.engine().read.markets([gpuId]);
    const feeCum = request.side === "long" ? mk.fundingChargePerUnitLong : mk.fundingChargePerUnitShort;
    const creditCum = request.side === "long" ? mk.fundingCreditPerUnitLong : mk.fundingCreditPerUnitShort;
    const sliceOwed = fundingOwed(sizeRaw, feeCum, raw.fundingFeeCheckpoint);
    const sliceBorrow = fundingOwed(sizeRaw, mk.borrowChargePerUnit, raw.borrowCheckpoint);
    const sliceEarned = fundingEarned(sizeRaw, creditCum, raw.fundingCreditCheckpoint);
    const released = mulDiv(view.position.collateral, sizeRaw, held, "floor");
    const pnlShare = pnl(sizeRaw, view.position.entryPrice, request.side === "long", price);
    const closeFee = feeBps(sizeRaw, closeFeeBps);
    const executionFee = await this.engine().read.MIN_EXECUTION_FEE();
    const dueRaw = released + pnlShare - closeFee - sliceOwed - sliceBorrow + sliceEarned;
    // The engine floors the settlement at zero: a close whose fees and
    // funding exceed its value settles nothing — the quote says so.
    const proceeds = dueRaw > 0n ? dueRaw : 0n;
    const shortfall = dueRaw < 0n ? -dueRaw : 0n;
    // The bound the close arms with — longs refuse a fill below it, shorts
    // above it (same derivation the submit pins).
    const acceptablePrice = acceptablePriceBound(price, tolerance(request), request.side === "long", false);

    return {
      asset: request.asset,
      side: request.side,
      sizeUsd: formatGusdRaw(sizeRaw),
      entryPrice: unscalePrice(view.position.entryPrice),
      referencePrice: unscalePrice(price),
      pnl: toUsdSigned(pnlShare),
      closeFee: formatGusdRaw(closeFee),
      executionFee: formatGusdRaw(executionFee),
      // This tranche's slice of the funding — the same pro-rata the
      // engine's decrease settles (negative = the position earns).
      fundingNet: toUsdSigned(sliceEarned) - toUsdSigned(sliceOwed + sliceBorrow),
      acceptablePrice: unscalePrice(acceptablePrice),
      proceeds: toUsdSigned(proceeds),
      shortfall: toUsdSigned(shortfall),
      quotedAtMs: Date.now(),
      blockNumber: await this.blockNumber(),
    };
  }

  // ------------------------------------------------------------- actions

  async open(request: PerpOpenRequest): Promise<ActionRecord> {
    const session = this.session();
    if (!session) throw new Error(NO_SESSION);
    const { owner } = session;
    const gpuId = gpuIdForAsset(request.asset);

    for (let attempt = 0; attempt < 3; attempt++) {
      const att = await this.bridgedAttestation(gpuId);
      if (att.kind !== "current") {
        if (attempt === 0) continue;
        throw new Error(NO_ATTESTATION);
      }
      const price = attestedPrice(att);
      if (price === null) throw new Error(NO_ATTESTATION);

      const market = await this.engine().read.getMarket([gpuId]);
      if (!market.market.enabled) throw new Error("This perp market is disabled right now.");
      const params = market.market.params;

      const collateralRaw = parseGusd(request.collateral);
      const leverageBps = BigInt(Math.round(request.leverage * 10_000));
      const sizeRaw = sizeFromCollateral(collateralRaw, leverageBps);
      // Same gates the preview ran; a surviving violation is a fact, voiced.
      if (collateralRaw <= 0n || sizeRaw === 0n) throw new Error("Enter a collateral amount greater than zero.");
      if (leverageBpsCeil(sizeRaw, collateralRaw) > params.maxLeverageBps) {
        throw new Error(
          `That leverage exceeds this market's ${Number(params.maxLeverageBps) / 100}× cap — lower it.`,
        );
      }
      if (sizeRaw > params.maxPositionUsd) {
        throw new Error(
          `That position exceeds this market's ${fmtGusdLedger(formatGusdRaw(params.maxPositionUsd))} gUSD cap — size down.`,
        );
      }
      const sideOi = request.side === "long" ? market.market.openNotionalLong : market.market.openNotionalShort;
      if (sideOi + sizeRaw > params.maxOiUsd) {
        throw new Error(
          `This market has ${fmtGusdLedger(formatGusdRaw(params.maxOiUsd - sideOi))} gUSD of open interest left on this side — size down.`,
        );
      }
      // Min collateral on the RESULTING position (an increase counts what's
      // already locked in it).
      const position = await this.engine().read.positions([owner, gpuId, request.side === "long"]).catch(() => null);
      const resultingColl = (position?.collateral ?? 0n) + collateralRaw;
      if (resultingColl < params.minCollateralUsd) {
        throw new Error(
          `This market needs ${fmtGusdLedger(formatGusdRaw(params.minCollateralUsd))} gUSD of collateral — raise the amount.`,
        );
      }

      const executionFee = await this.engine().read.MIN_EXECUTION_FEE();
      const needRaw = collateralRaw + executionFee;

      // Balance pre-flight: the engine pulls collateral + fee at create.
      const { gusd } = getContracts();
      const heldRaw = await gusd.read.balanceOf([owner]);
      if (heldRaw < needRaw) throw new Error(NO_WALLET_BALANCE);

      const approvals: ApprovalNeed[] = [];
      const need = await planApproval(
        getContracts().addresses.gusd as Address,
        "gUSD",
        getContracts().addresses.perpEngine as Address,
        "perpEngine",
        owner,
        needRaw,
      );
      if (need) approvals.push(need);

      const acceptablePrice = acceptablePriceBound(
        price, tolerance(request), request.side === "long", true,
      );
      const orderParams = {
        market: gpuId,
        kind: PERP_ORDER_KIND.open,
        isLong: request.side === "long",
        sizeDeltaUsd: sizeRaw,
        collateralDeltaUsd: collateralRaw,
        acceptablePrice,
        triggerPrice: 0n,
        executionFee,
      };

      // createOrder carries no report — the simulation has nothing to heal.
      const simulateCall = async () =>
        simulateWrite({
          address: getContracts().addresses.perpEngine as Address,
          abi: GPU_PERP_ENGINE_ABI,
          functionName: "createOrder",
          args: [orderParams],
          account: owner,
        });
      if (approvals.length === 0) {
        const result = await simulateCall();
        if (!result.ok) throw new Error(result.error.voice);
      }

      const blockNumber = await this.blockNumber();
      const label = `Open ${request.side === "long" ? "long" : "short"} ${request.asset} · ${fmtGusdLedger(request.collateral)} gUSD ×${trim(request.leverage)} → ${fmtGusdLedger(formatGusdRaw(sizeRaw))}`;
      const nextOrderId = (await this.engine().read.orderNonce()) + 1n;

      const plan: ActionPlan = {
        origin: "perp-open",
        label,
        quote: {
          quotedAtMs: Date.now(),
          blockNumber,
          totals: {
            collateral: request.collateral,
            size: formatGusdRaw(sizeRaw),
            openFee: formatGusdRaw(feeBps(sizeRaw, BigInt(params.openFeeBps))),
            executionFee: formatGusdRaw(executionFee),
            acceptablePrice: unscalePrice(acceptablePrice),
          },
        },
        approvals,
        simulate:
          approvals.length === 0
            ? undefined
            : async () => {
                const result = await simulateCall();
                return result.ok ? result : { ok: false, error: result.error.voice };
              },
        buildSpec: () => perpCreateOrderSpec(orderParams),
        reconcile: this.deps.reconcile,
      };
      const record = await this.deps.actions.run(plan);
      if (record.phase === "complete") this.sessionOrderIds.push(nextOrderId);
      return record;
    }
    throw new Error(NO_ATTESTATION);
  }

  async close(request: PerpCloseRequest): Promise<ActionRecord> {
    const session = this.session();
    if (!session) throw new Error(NO_SESSION);
    return this.submitDecrease(
      session.owner,
      request.asset,
      request.side,
      PERP_ORDER_KIND.close,
      request.size === null ? 0n : parseGusd(request.size),
      0n, // acceptablePrice set below from the pinned report
      (price, toleranceBps, isLong) =>
        // Longs close dear (≥ bound), shorts close cheap (≤ bound).
        acceptablePriceBound(price, toleranceBps, isLong, false),
      (full, sizeRaw) =>
        full === sizeRaw
          ? `Close ${request.side === "long" ? "long" : "short"} ${request.asset}`
          : `Close ${fmtGusdLedger(formatGusdRaw(sizeRaw))} of ${request.side === "long" ? "long" : "short"} ${request.asset}`,
      { kind: "close", toleranceBps: request.toleranceBps },
    );
  }

  async armTrigger(request: PerpTriggerRequest): Promise<ActionRecord> {
    const session = this.session();
    if (!session) throw new Error(NO_SESSION);
    const kind = PERP_ORDER_KIND[request.kind];
    const triggerRaw = unscale(request.triggerPrice);
    if (triggerRaw <= 0n) throw new Error("Enter a trigger price greater than zero.");
    return this.submitDecrease(
      session.owner,
      request.asset,
      request.side,
      kind,
      request.size === null ? 0n : parseGusd(request.size),
      triggerRaw,
      // Triggers carry no acceptable price — the trigger condition IS the
      // bound, re-verified fail-closed against the fresh report at execution.
      () => 0n,
      (_full, _sizeRaw) =>
        `${request.kind === "stop-loss" ? "Stop-loss" : "Take-profit"} ${request.side === "long" ? "long" : "short"} ${request.asset} @ ${fmtGusdPrecise(request.triggerPrice)}`,
      { kind: "trigger", toleranceBps: 0 },
    );
  }

  /**
   * The shared decrease/trigger submit: locks only the execution fee,
   * simulates the exact createOrder calldata, and signs. Both market closes
   * and triggers are reduceOnly — sizeDelta 0 means "whole position" on the
   * engine, which clamps an oversize request to held at execution.
   */
  private async submitDecrease(
    owner: Address,
    asset: AssetId,
    side: PerpSide,
    kind: (typeof PERP_ORDER_KIND)[keyof typeof PERP_ORDER_KIND],
    sizeRaw: bigint,
    triggerRaw: bigint,
    bound: (price: bigint, toleranceBps: bigint, isLong: boolean) => bigint,
    label: (full: bigint, sizeRaw: bigint) => string,
    opts: { kind: "close" | "trigger"; toleranceBps?: number },
  ): Promise<ActionRecord> {
    const gpuId = gpuIdForAsset(asset);
    const isLong = side === "long";

    for (let attempt = 0; attempt < 3; attempt++) {
      const att = await this.bridgedAttestation(gpuId);
      if (att.kind !== "current") {
        if (attempt === 0) continue;
        throw new Error(NO_ATTESTATION);
      }
      const price = attestedPrice(att);
      if (price === null) throw new Error(NO_ATTESTATION);

      // reduceOnly pre-flight: the position must exist, and an oversize
      // close clamps to held rather than refusing (the engine does the same).
      const position = await this.engine()
        .read.positions([owner, gpuId, isLong])
        .catch(() => null);
      if (!position || position.sizeUsd === 0n) {
        throw new Error("There's no position here to close.");
      }
      const full = position.sizeUsd;
      const sizeDelta = sizeRaw === 0n ? full : clampRaw(sizeRaw, full);

      const executionFee = await this.engine().read.MIN_EXECUTION_FEE();
      const { gusd } = getContracts();
      const heldRaw = await gusd.read.balanceOf([owner]);
      if (heldRaw < executionFee) throw new Error(NO_FEE_BALANCE);

      const approvals: ApprovalNeed[] = [];
      const need = await planApproval(
        getContracts().addresses.gusd as Address,
        "gUSD",
        getContracts().addresses.perpEngine as Address,
        "perpEngine",
        owner,
        executionFee,
      );
      if (need) approvals.push(need);

      const acceptablePrice =
        opts.kind === "close"
          ? bound(price, BigInt(Math.max(0, Math.round(opts.toleranceBps ?? 0))), isLong)
          : 0n;
      const orderParams = {
        market: gpuId,
        kind,
        isLong,
        sizeDeltaUsd: sizeDelta,
        collateralDeltaUsd: 0n,
        acceptablePrice,
        triggerPrice: triggerRaw,
        executionFee,
      };

      const simulateCall = async () =>
        simulateWrite({
          address: getContracts().addresses.perpEngine as Address,
          abi: GPU_PERP_ENGINE_ABI,
          functionName: "createOrder",
          args: [orderParams],
          account: owner,
        });
      if (approvals.length === 0) {
        const result = await simulateCall();
        if (!result.ok) throw new Error(result.error.voice);
      }

      const blockNumber = await this.blockNumber();
      const nextOrderId = (await this.engine().read.orderNonce()) + 1n;
      const plan: ActionPlan = {
        origin: kind === PERP_ORDER_KIND.close ? "perp-close" : "perp-trigger",
        label: label(full, sizeDelta),
        quote: {
          quotedAtMs: Date.now(),
          blockNumber,
          totals: {
            size: formatGusdRaw(sizeDelta),
            executionFee: formatGusdRaw(executionFee),
            ...(opts.kind === "close"
              ? { acceptablePrice: unscalePrice(acceptablePrice) }
              : { triggerPrice: unscalePrice(triggerRaw) }),
          },
        },
        approvals,
        simulate:
          approvals.length === 0
            ? undefined
            : async () => {
                const result = await simulateCall();
                return result.ok ? result : { ok: false, error: result.error.voice };
              },
        buildSpec: () => perpCreateOrderSpec(orderParams),
        reconcile: this.deps.reconcile,
      };
      const record = await this.deps.actions.run(plan);
      if (record.phase === "complete") this.sessionOrderIds.push(nextOrderId);
      return record;
    }
    throw new Error(NO_ATTESTATION);
  }

  async cancelOrder(orderId: number): Promise<ActionRecord> {
    const session = this.session();
    if (!session) throw new Error(NO_SESSION);
    const id = BigInt(orderId);
    const order = await this.engine().read.orders([id]).catch(() => null);
    if (!order || order.account !== session.owner) {
      throw new Error("That order isn't yours to cancel.");
    }
    if (order.status !== 1) throw new Error("That order already resolved — nothing to cancel.");
    const plan: ActionPlan = {
      origin: "perp-cancel",
      label: `Cancel order #${orderId}`,
      quote: null,
      approvals: [],
      buildSpec: () => perpCancelSpec(id),
      reconcile: this.deps.reconcile,
    };
    return this.deps.actions.run(plan);
  }

  async claim(amount: number): Promise<ActionRecord> {
    const session = this.session();
    if (!session) throw new Error(NO_SESSION);
    const { owner } = session;
    const claimable = await this.engine().read.claimableOf([owner]).catch(() => 0n);
    if (claimable === 0n) throw new Error("There's nothing settled to claim right now.");
    const amountRaw = amount <= 0 ? claimable : clampRaw(parseGusd(amount), claimable);
    if (amountRaw === 0n) throw new Error("Enter an amount greater than zero.");
    const plan: ActionPlan = {
      origin: "perp-claim",
      label: `Claim ${fmtGusdLedger(formatGusdRaw(amountRaw))} gUSD`,
      quote: {
        quotedAtMs: Date.now(),
        blockNumber: await this.blockNumber(),
        totals: { claim: formatGusdRaw(amountRaw) },
      },
      approvals: [],
      buildSpec: () => perpClaimSpec(amountRaw, owner),
      reconcile: this.deps.reconcile,
    };
    return this.deps.actions.run(plan);
  }
}

// ------------------------------------------------------------- helpers

/** The request's tolerance in raw bps (0 when absent). */
function tolerance(request: { toleranceBps?: number }): bigint {
  return BigInt(Math.max(0, Math.round(request.toleranceBps ?? 0)));
}

/** A display price (×10_000 float) → the raw scaled bigint. */
function unscale(price: number): bigint {
  return BigInt(Math.round(price * 10_000));
}

function clampRaw(value: bigint, cap: bigint): bigint {
  return value > cap ? cap : value;
}

function trim(leverage: number): string {
  const s = String(Math.round(leverage * 100) / 100);
  return s.endsWith(".00") ? s.slice(0, -3) : s.endsWith("0") ? s.slice(0, -1) : s;
}

/** The oracle proxy's perp orders endpoint, inert when the indexer URL is
 *  absent — the same discipline as the indexer client: any failure resolves
 *  to null and the port falls back to session-local order reads. */
async function fetchIndexedPendingOrders(owner: Address): Promise<PerpPendingOrder[] | null> {
  const url = process.env.NEXT_PUBLIC_INDEXER_URL?.trim();
  if (!url) return null;
  const params = new URLSearchParams({ address: owner.toLowerCase(), status: "1", limit: "50" });
  try {
    const res = await fetch(`${url}/perp/orders?${params.toString()}`, {
      signal: AbortSignal.timeout(5_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { orders?: unknown };
    if (!Array.isArray(body.orders)) return null;
    const out: PerpPendingOrder[] = [];
    for (const dto of body.orders as {
      orderId: string;
      gpuId: string;
      kind: number;
      isLong: boolean;
      sizeDeltaUsd: string;
      collateralDeltaUsd: string;
      acceptablePrice: string;
      triggerPrice: string;
      executionFee: string;
      createdAtSec: number;
    }[]) {
      const asset = assetForWireGpuId(dto.gpuId);
      if (!asset) continue;
      out.push({
        orderId: Number(BigInt(dto.orderId)),
        asset,
        kind: KIND_LABEL[dto.kind] ?? "open",
        side: dto.isLong ? "long" : "short",
        sizeUsd: Number(dto.sizeDeltaUsd) / 1e6,
        collateral: Number(dto.collateralDeltaUsd) / 1e6,
        price: unscalePrice(BigInt(dto.kind === 2 || dto.kind === 3 ? dto.triggerPrice : dto.acceptablePrice)),
        executionFee: Number(dto.executionFee) / 1e6,
        createdAt: dto.createdAtSec * 1000,
      });
    }
    return out;
  } catch {
    return null;
  }
}

/** The engine's Order struct → the domain's pending-order vocabulary; null
 *  when the market's gpuId doesn't decode to a product asset. */
type EngineOrder = Awaited<ReturnType<PerpEngineContract["read"]["orders"]>>;

function projectOrder(id: bigint, o: EngineOrder): PerpPendingOrder | null {
  const asset = assetForGpuId(o.market);
  if (!asset) return null;
  const isTrigger = Number(o.kind) === 2 || Number(o.kind) === 3;
  return {
    orderId: Number(id),
    asset,
    kind: KIND_LABEL[Number(o.kind)] ?? "open",
    side: o.isLong ? "long" : "short",
    sizeUsd: formatGusdRaw(o.sizeDeltaUsd),
    collateral: formatGusdRaw(o.collateralDeltaUsd),
    price: unscalePrice(isTrigger ? o.triggerPrice : o.acceptablePrice),
    executionFee: formatGusdRaw(o.executionFee),
    createdAt: Number(o.createdAt) * 1000,
  };
}