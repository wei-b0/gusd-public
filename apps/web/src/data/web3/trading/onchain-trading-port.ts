/**
 * The real trading port — GPU ⇄ gUSD through the shared action runner.
 * Every submit re-quotes fresh — the desk's displayed quote is a preview;
 * the plan signs against one computed at submit time — then becomes one
 * ActionPlan: the balance pre-flight (a short wallet is refused before any
 * signature is requested), the gUSD or GPU approval when the allowance is
 * short, a pre-signature simulation of the exact calldata, and
 * reconciliation of the account store on confirmation. Quote and execution run the same
 * protocol pricing path and math; the signed caps (`maxPaid`/`minOut`)
 * bound the fill if state moves between quote and inclusion. The account
 * view projects the interim onchain account store (the Ponder successor
 * lands later) — never demo capital, never invented cost basis.
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
import { fmtAddress, fmtGusdLedger, fmtUnits } from "@/domain/format";
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
import { TRADE_DEADLINE_SECS, buySpec, sellSpec } from "./specs";

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
    return quoteAsset(
      request.asset,
      request.side,
      request.size,
      request.toleranceBps ?? DEFAULT_TOLERANCE_BPS,
      this.quoteDeps,
    );
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
    const sizeRaw = parseGpuUnits(request.size);
    const approvals: ApprovalNeed[] = [];
    if (request.side === "buy") {
      // Balance pre-flight, before any signature is requested: the router
      // pulls the full signed cap up front (change refunded), so the
      // wallet must hold the cap — a short wallet is refused here rather
      // than asked to approve an order that can't fill. Mint and earn
      // gate their balances the same way.
      const capRaw = parseGusd(quote.maxPaid);
      const heldRaw = await this.quoteDeps.reads.balanceOf(
        getContracts().addresses.gusd as Address,
        owner,
      );
      if (heldRaw < capRaw) {
        throw new Error(
          `This wallet holds ${fmtGusdLedger(formatGusdRaw(heldRaw))} gUSD — this buy needs up to ${fmtGusdLedger(quote.maxPaid)} gUSD. Mint gUSD from the reserve asset first.`,
        );
      }
      const need = await planApproval(
        getContracts().addresses.gusd as Address,
        "gUSD",
        getContracts().addresses.router as Address,
        "router",
        owner,
        capRaw,
      );
      if (need) approvals.push(need);
    } else {
      const reg = await this.quoteDeps.reads.registration(gpuId);
      if (!reg) throw new Error(NO_QUOTE);
      // Same pre-flight on the sell side: no GPU holding, no approval ask.
      const heldRaw = await this.quoteDeps.reads.balanceOf(reg.token, owner);
      if (heldRaw < sizeRaw) {
        throw new Error(
          `This wallet holds ${fmtUnits(formatGpuUnits(heldRaw))} ${request.asset} — this sell needs ${fmtUnits(request.size)} ${request.asset}.`,
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
      maxPaid: parseGusd(quote.maxPaid),
      deadline: BigInt(Math.floor(Date.now() / 1000) + TRADE_DEADLINE_SECS),
      sqrtLimitX96: 0n,
      recipient: owner,
    });
    const sellStruct = () => ({
      gpuId,
      gpuIn: sizeRaw,
      payout: getContracts().addresses.gusd as Address,
      minOut: parseGusd(quote.minOut),
      deadline: BigInt(Math.floor(Date.now() / 1000) + TRADE_DEADLINE_SECS),
      sqrtLimitX96: 0n,
      recipient: owner,
    });

    const plan: ActionPlan = {
      origin: "trade",
      label:
        request.side === "buy"
          ? `Buy ${fmtUnits(request.size)} ${request.asset}`
          : `Sell ${fmtUnits(request.size)} ${request.asset}`,
      quote: tradeSnapshot(quote),
      approvals,
      simulate: async () => {
        const { router } = getContracts();
        const result = await simulateWrite({
          address: router.address,
          abi: GPU_ROUTER_ABI,
          functionName: request.side === "buy" ? "buy" : "sell",
          args: request.side === "buy" ? [buyStruct()] : [sellStruct()],
          account: owner,
        });
        return result.ok ? result : { ok: false, error: result.error.voice };
      },
      buildSpec: () =>
        request.side === "buy"
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
