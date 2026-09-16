/**
 * The real trading port — GPU ⇄ gUSD through the shared action runner.
 * Every submit re-quotes fresh — the desk's displayed quote is a preview;
 * the plan signs against one computed at submit time — then becomes one
 * ActionPlan: the balance pre-flight (a short wallet is refused before any
 * signature is requested), the gUSD or GPU approval when the allowance is
 * short, a pre-signature simulation of the exact calldata, and
 * reconciliation of the account store on confirmation.
 *
 * Execution is pull-oracle shaped: the port fetches ONE current attestation
 * R and pins it across the whole span — re-quotes against exactly R,
 * simulates the exact calldata that embeds R, and signs calldata carrying
 * the same R — so what the user saw, what simulated, and what lands on
 * chain are one report (the plan's quote→simulate→sign doctrine). A report
 * that expires mid-flight (epoch rolled) is retried once with a fresh
 * fetch; past that, the refusal is the honest "no current attestation".
 *
 * Money-first requests execute on the basis they quote: spend-exact buys
 * ride `buyExactIn` — the typed gUSD is pulled in full with no refund, so
 * the units guarantee is the signed `minSize` floor — while an all-issuance
 * fill (genesis, or a pool fill the backstop covered entirely) rides
 * `buy` under the refundable typed-spend cap; proceeds-first sells ride
 * `sell` with the units the inverse quote derived, under the payout floor.
 * Quote and execution run the same protocol pricing path and math; the
 * signed limits (`maxPaid`/`minOut`/`minSize`) bound the fill if state
 * moves between quote and inclusion. The account view projects the interim
 * onchain account store and indexed protocol reads — never demo
 * capital, never invented cost basis.
 */

import type { Address } from "viem";
import type { ActionPort, TradingPort } from "@/domain/ports";
import type { ActionPlan, ActionRecord, ApprovalNeed, QuoteSnapshot } from "@/domain/actions";
import type {
  Account,
  AssetId,
  QuoteFailure,
  TradeAvailability,
  TradeQuote,
  TradeRequest,
} from "@/domain/types";
import { fmtAddress, fmtGusdLedger, fmtUnits, fmtUnitsLedger } from "@/domain/format";
import { legUnits } from "@/domain/types";
import { formatGpuUnits, formatGusdRaw, parseGpuUnits, parseGusd } from "@/domain/units";
import { GPU_ROUTER_ABI } from "../abis/gpu_router";
import { getContracts } from "../contracts";
import { simulateWrite } from "../simulate";
import { planApproval } from "../approvals";
import { gpuIdForAsset } from "../gpu-id";
import type { OnChainAccountStore } from "@/data/onchain/account-store";
import type { Attestation } from "@/data/oracle/attestation";
import {
  DEFAULT_TOLERANCE_BPS,
  describeAsset,
  quoteAsset,
  quoteAssetDetailed,
  type QuoteDeps,
  defaultQuoteDeps,
} from "./quotes";
import { TRADE_DEADLINE_SECS, buyExactInSpec, buySpec, sellSpec } from "./specs";

export interface OnChainTradingPortDeps {
  /** The session source — the port refuses to act without one. */
  getSession(): { status: string; address: string | null };
  actions: ActionPort;
  /** The interim onchain user-state store the account view projects. */
  accountStore: OnChainAccountStore;
  /** Post-confirmation refresh (the account store). */
  reconcile?: (txIds: readonly string[]) => Promise<unknown>;
  /** Quote/read seam, injectable for tests. */
  quoteDeps?: QuoteDeps;
}

const NO_SESSION = "Connect a wallet to trade — nothing signs without one.";
const NO_QUOTE = "This order can't be quoted right now — check the size and try again.";
/** No current-epoch report at execute time — the attestor's liveness, not
 *  the market's. One retry happens inside; past that the order refuses. */
const NO_ATTESTATION =
  "The oracle has no current price report right now — orders wait for the attestor's next attestation. Try again in a moment.";

/** Revert names that mean "the pinned report expired" — the one failure a
 *  fresh attestation legitimately fixes; retried once, everything else
 *  surfaces as its own voice. */
const EXPIRY_ERRORS = new Set(["UnknownGpuEpoch", "StaleObservation", "FutureObservation"]);

/** The slip's quote is a preview: it must fail fast, not hang. One flaky
 *  RPC read stalls the whole mirror batch (a single Promise.all over a
 *  dozen views), and an unsettled quote leaves the submit gated with the
 *  fallback ledger on screen — indistinguishable from a broken button.
 *  Past this budget the slip speaks the typed retry voice instead; the
 *  debounce refires on the next settled input anyway. */
const QUOTE_TIMEOUT_MS = 2_500;

/** Rejects with the typed timeout failure after `ms` — the losing branch
 *  of the race below; the underlying read is abandoned, not cancelled. */
function quoteTimeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("quote-timeout")), ms);
  });
}

export class OnChainTradingPort implements TradingPort {
  private readonly quoteDeps: QuoteDeps;
  /** Cached account projection — a stable reference between store changes. */
  private account: Account;

  constructor(private readonly deps: OnChainTradingPortDeps) {
    this.quoteDeps = deps.quoteDeps ?? defaultQuoteDeps();
    this.account = projectAccount(this.deps.accountStore.get());
    this.deps.accountStore.subscribe(() => {
      const next = projectAccount(this.deps.accountStore.get());
      // Reference equality guard: the store freezes snapshots, so identical
      // state skips the re-render entirely.
      if (next !== this.account) {
        this.account = next;
        this.emit();
      }
    });
  }

  private listeners = new Set<(account: Account) => void>();

  private emit(): void {
    for (const listener of this.listeners) listener(this.account);
  }

  getAccount(): Account {
    return this.account;
  }

  subscribe(listener: (account: Account) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async describeAsset(asset: AssetId): Promise<TradeAvailability | null> {
    return describeAsset(asset, this.quoteDeps);
  }

  async quote(request: TradeRequest): Promise<TradeQuote | null> {
    return quoteAsset(request, this.quoteDeps);
  }

  async quoteDetailed(request: TradeRequest): Promise<TradeQuote | QuoteFailure | null> {
    try {
      return await Promise.race([
        quoteAssetDetailed(request, this.quoteDeps),
        quoteTimeout(QUOTE_TIMEOUT_MS),
      ]);
    } catch (err) {
      // Only the timeout becomes a typed retry voice; genuine quote errors
      // keep their existing behavior (the slip's catch renders them null).
      if (err instanceof Error && err.message === "quote-timeout") {
        return { unavailable: true, reason: "quote-timeout" };
      }
      throw err;
    }
  }

  async execute(request: TradeRequest): Promise<ActionRecord> {
    const session = this.deps.getSession();
    if (session.status !== "connected" || !session.address) {
      throw new Error(NO_SESSION);
    }
    const owner = session.address as Address;
    const tolerance = request.toleranceBps ?? DEFAULT_TOLERANCE_BPS;
    const gpuId = gpuIdForAsset(request.asset);

    // Two attempts: the pinned report either holds through simulate, or it
    // expired (epoch rolled) and ONE fresh fetch re-runs the whole span.
    // Everything else fails with its own voice.
    let lastVoice: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      // 1. The report this order will embed — fetched fresh at submit.
      const attestation = await this.quoteDeps.attestation(request.asset);
      if (attestation.kind !== "current") {
        if (attempt === 0) continue; // one refetch before refusing
        throw new Error(NO_ATTESTATION);
      }

      // 2. Re-quote against EXACTLY this report — the signed limits derive
      //    from the same price the trade embeds, never from the desk's
      //    (older) preview.
      const quote = await quoteAssetDetailed(
        { ...request, toleranceBps: tolerance },
        this.pinnedDeps(attestation),
      );
      if (!quote || "unavailable" in quote) {
        if (quote && "unavailable" in quote && quote.reason === "oracle-stale" && attempt === 0) {
          continue; // the report expired between fetch and quote — refetch
        }
        throw new Error(NO_QUOTE);
      }

      const approvals: ApprovalNeed[] = [];

      // The units this order moves, raw: units-basis trades move the typed
      // size; money-first trades move what the pinned quote derived (the
      // proceeds-first sell's gross units; the spend-exact buy's derived
      // size — its signed guarantee is the minSize floor, not that size).
      const sizeRaw =
        request.basis === "units" ? parseGpuUnits(request.size) : parseGpuUnits(quote.size);
      const spendRaw = parseGusd(quote.maxPaid);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + TRADE_DEADLINE_SECS);

      // A money-first buy with any pool leg executes spend-exact through
      // `buyExactIn`; an all-issuance fill — genesis, or a pool fill the
      // backstop covered entirely — rides `buy` under the typed-spend cap,
      // tail refunded. Both pre-flight against the same typed spend.
      const exactPullBuy =
        request.side === "buy" &&
        request.basis === "gusd" &&
        quote.legs.some((leg) => leg.kind === "pool");

      if (request.side === "buy") {
        // Balance pre-flight, before any signature is requested: the wallet
        // must hold the full spend — a short wallet is refused here rather
        // than asked to approve an order that can't fill. Mint and earn
        // gate their balances the same way. Voice follows the pull: the
        // spend-exact path takes it all (no refund), every other buy signs
        // a refundable cap.
        const heldRaw = await this.quoteDeps.reads.balanceOf(
          getContracts().addresses.gusd as Address,
          owner,
        );
        if (heldRaw < spendRaw) {
          // The held figure prints floored at the ledger grain — it never
          // reads above the true raw, so it can't visually equal the demand.
          const held = Math.floor(formatGusdRaw(heldRaw) * 1e4) / 1e4;
          throw new Error(
            exactPullBuy
              ? `This wallet holds ${fmtGusdLedger(held)} gUSD — this buy spends ${fmtGusdLedger(quote.maxPaid)} gUSD in full. Mint gUSD from the reserve asset first.`
              : `This wallet holds ${fmtGusdLedger(held)} gUSD — this buy needs up to ${fmtGusdLedger(quote.maxPaid)} gUSD. Mint gUSD from the reserve asset first.`,
          );
        }
        // The exact-pull approval is the typed spend itself; the capped one
        // is the same number — the tolerance-padded cap in units mode.
        const need = await planApproval(
          getContracts().addresses.gusd as Address,
          "gUSD",
          getContracts().addresses.router as Address,
          "router",
          owner,
          spendRaw,
        );
        if (need) approvals.push(need);
      } else {
        const reg = await this.quoteDeps.reads.registration(gpuId);
        if (!reg) throw new Error(NO_QUOTE);
        // Same pre-flight on the sell side: no GPU holding, no approval ask.
        const heldRaw = await this.quoteDeps.reads.balanceOf(reg.token, owner);
        if (heldRaw < sizeRaw) {
          // Held prints floored at the 4-dec ledger grain ("holds 6.9338 —
          // needs 6.9340") so the two figures stay distinct even when the
          // 3-dec rounded forms would read identical.
          const held = Math.floor(formatGpuUnits(heldRaw) * 1e4) / 1e4;
          throw new Error(
            `This wallet holds ${fmtUnitsLedger(held)} ${request.asset} — this sell needs ${fmtUnitsLedger(quote.size)} ${request.asset}.`,
          );
        }
        const need = await planApproval(
          reg.token,
          request.asset,
          getContracts().addresses.router as Address,
          "router",
          owner,
          sizeRaw,
        );
        if (need) approvals.push(need);
      }

      const updateData = attestation.updateData;
      const buyStruct = () => ({
        gpuId,
        gpuOut: sizeRaw,
        payment: getContracts().addresses.gusd as Address,
        maxPaid: spendRaw,
        deadline,
        sqrtLimitX96: 0n,
        recipient: owner,
        updateData,
      });
      const sellStruct = () => ({
        gpuId,
        gpuIn: sizeRaw,
        payout: getContracts().addresses.gusd as Address,
        minOut: parseGusd(quote.minOut),
        deadline,
        sqrtLimitX96: 0n,
        recipient: owner,
        updateData,
      });

      // 3. Simulate the EXACT calldata that will be signed — same report,
      //    same limits. When the allowance already covers the spend there
      //    is nothing left to approve, so the simulation runs HERE and an
      //    expired report is the one failure a fresh fetch legitimately
      //    fixes. When an approval is needed, the eth_call would revert on
      //    the missing allowance before the trade is even priced — so the
      //    simulation rides plan.simulate instead, which the runner fires
      //    after the approvals have landed, over the same pinned calldata.
      const { router } = getContracts();
      const simulateFn = exactPullBuy ? "buyExactIn" : request.side === "buy" ? "buy" : "sell";
      const simulateArgs = exactPullBuy
        ? [gpuId, spendRaw, parseGpuUnits(quote.minSize), deadline, 0n, updateData, owner]
        : request.side === "buy"
          ? [buyStruct()]
          : [sellStruct()];
      const simulateCall = async () =>
        simulateWrite({
          address: router.address,
          abi: GPU_ROUTER_ABI,
          functionName: simulateFn,
          args: simulateArgs,
          account: owner,
        });
      if (approvals.length === 0) {
        const result = await simulateCall();
        if (!result.ok) {
          if (
            result.error.errorName !== null &&
            EXPIRY_ERRORS.has(result.error.errorName) &&
            attempt === 0
          ) {
            continue; // the report expired — one refetch, then surface
          }
          lastVoice = result.error.voice;
          throw new Error(result.error.voice);
        }
      }

      // 4. Sign the same calldata. buildSpec runs at signature time but
      //    pins the SAME report: the user signed what simulated, and an
      //    epoch that rolls before inclusion reverts on-chain (bounded by
      //    the report's validity window) instead of silently repricing.
      const plan: ActionPlan = {
        origin: "trade",
        label:
          request.basis === "gusd"
            ? request.side === "buy"
              ? `Buy ~${fmtUnitsLedger(quote.size)} ${request.asset} · ${fmtGusdLedger(quote.maxPaid)} gUSD`
              : `Sell ~${fmtUnitsLedger(quote.size)} ${request.asset} · ~${fmtGusdLedger(quote.notional)} gUSD`
            : request.side === "buy"
              ? `Buy ${fmtUnits(request.size)} ${request.asset}`
              : `Sell ${fmtUnits(request.size)} ${request.asset}`,
        quote: tradeSnapshot(quote),
        approvals,
        // The runner's pre-signature check: skipped above only when the
        // allowance already covered the spend (that path simulated in the
        // port, where the expiry retry lives) — otherwise this is the one
        // simulation, run after the approvals land over the same pinned
        // calldata. Either way, no signature is requested for a call that
        // reverts.
        simulate: async () => {
          const result = await simulateCall();
          return result.ok ? result : { ok: false, error: result.error.voice };
        },
        buildSpec: () =>
          exactPullBuy
            ? buyExactInSpec(
                { gpuId, gusdMaxIn: spendRaw, minGpuOut: parseGpuUnits(quote.minSize), deadline, sqrtLimitX96: 0n, updateData },
                owner,
              )
            : request.side === "buy"
              ? buySpec(buyStruct(), owner)
              : sellSpec(sellStruct(), owner),
        reconcile: this.deps.reconcile,
      };

      return this.deps.actions.run(plan);
    }
    // Unreachable: each loop iteration either returns or throws; the
    // compiler wants the exhaustiveness guard anyway.
    throw new Error(lastVoice ?? NO_ATTESTATION);
  }

  /** A quote stack whose attestation always answers the pinned report —
   *  the re-quote that keeps limits and embedded report in one world. */
  private pinnedDeps(attestation: Attestation): QuoteDeps {
    return { ...this.quoteDeps, attestation: async () => attestation };
  }
}

function tradeSnapshot(quote: TradeQuote): QuoteSnapshot {
  return {
    quotedAtMs: quote.quotedAtMs,
    blockNumber: quote.blockNumber,
    totals:
      quote.side === "buy"
        ? {
            size: quote.size,
            maxPaid: quote.maxPaid,
            notional: quote.notional,
            minUnits: quote.minSize,
            poolLeg: legUnits(quote, "pool"),
            issuanceLeg: legUnits(quote, "issuance"),
          }
        : { size: quote.size, minOut: quote.minOut, notional: quote.notional },
  };
}

/** The onchain snapshot → the Account vocabulary the shell already renders. */
function projectAccount(snap: {
  address: string | null;
  gUsd: number;
  sGusd: number;
  stable: number;
  positions: readonly {
    gpuId: `0x${string}`;
    asset: AssetId | null;
    size: number;
    avgEntry: number | null;
    realizedPnl: number | null;
    basisReason: string | null;
  }[];
}): Account {
  return {
    connected: snap.address !== null,
    label: snap.address ? fmtAddress(snap.address) : null,
    address: snap.address,
    gUsdBalance: snap.gUsd,
    sGUsdBalance: snap.sGusd,
    stableBalance: snap.stable,
    // Cost basis arrives from the indexed seam (avgEntry/realizedPnl null
    // until complete, `basisReason` naming the gate): the UI prints the
    // figure or "—" with the reason, never a fabricated 0. Snapshots from
    // a basis-less source normalize to null, never undefined.
    positions: snap.positions.flatMap((p) =>
      p.asset
        ? [
            {
              asset: p.asset,
              size: p.size,
              avgEntry: p.avgEntry ?? null,
              realizedPnl: p.realizedPnl ?? null,
              basisReason: p.basisReason ?? null,
            },
          ]
        : [],
    ),
  };
}
