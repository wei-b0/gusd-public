/**
 * The real trading port — GPU ⇄ gUSD through the shared action runner.
 * Every submit re-quotes fresh — the desk's displayed quote is a preview;
 * the plan signs against one computed at submit time — then becomes one
 * ActionPlan: the balance pre-flight (a short wallet is refused before any
 * signature is requested), the gUSD or GPU approval when the allowance is
 * short, a pre-signature simulation of the exact calldata, and
 * reconciliation of the account store on confirmation.
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
 * onchain account store (the Ponder successor lands later) — never demo
 * capital, never invented cost basis.
 */

import type { Address } from "viem";
import type { ActionPort, TradingPort } from "@/domain/ports";
import type { ActionPlan, ActionRecord, ApprovalNeed, QuoteSnapshot } from "@/domain/actions";
import type {
  Account,
  AssetId,
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
import {
  DEFAULT_TOLERANCE_BPS,
  describeAsset,
  quoteAsset,
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

  async execute(request: TradeRequest): Promise<ActionRecord> {
    const session = this.deps.getSession();
    if (session.status !== "connected" || !session.address) {
      throw new Error(NO_SESSION);
    }
    const owner = session.address as Address;
    const tolerance = request.toleranceBps ?? DEFAULT_TOLERANCE_BPS;
    const quote = await this.quote({ ...request, toleranceBps: tolerance });
    if (!quote) throw new Error(NO_QUOTE);

    const gpuId = gpuIdForAsset(request.asset);
    const approvals: ApprovalNeed[] = [];

    // The units this order moves, raw: units-basis trades move the typed
    // size; money-first trades move what the fresh quote derived (the
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

    const buyStruct = () => ({
      gpuId,
      gpuOut: sizeRaw,
      payment: getContracts().addresses.gusd as Address,
      maxPaid: spendRaw,
      deadline,
      sqrtLimitX96: 0n,
      recipient: owner,
    });
    const sellStruct = () => ({
      gpuId,
      gpuIn: sizeRaw,
      payout: getContracts().addresses.gusd as Address,
      minOut: parseGusd(quote.minOut),
      deadline,
      sqrtLimitX96: 0n,
      recipient: owner,
    });

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
      simulate: async () => {
        const { router } = getContracts();
        const result = await simulateWrite({
          address: router.address,
          abi: GPU_ROUTER_ABI,
          functionName: exactPullBuy ? "buyExactIn" : request.side === "buy" ? "buy" : "sell",
          args: exactPullBuy
            ? [gpuId, spendRaw, parseGpuUnits(quote.minSize), deadline, 0n, owner]
            : request.side === "buy"
              ? [buyStruct()]
              : [sellStruct()],
          account: owner,
        });
        return result.ok ? result : { ok: false, error: result.error.voice };
      },
      buildSpec: () =>
        exactPullBuy
          ? buyExactInSpec(
              { gpuId, gusdMaxIn: spendRaw, minGpuOut: parseGpuUnits(quote.minSize), deadline, sqrtLimitX96: 0n },
              owner,
            )
          : request.side === "buy"
            ? buySpec(buyStruct(), owner)
            : sellSpec(sellStruct(), owner),
      reconcile: this.deps.reconcile,
    };

    return this.deps.actions.run(plan);
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
