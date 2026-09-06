/**
 * The real trading port — GPU ⇄ gUSD through the shared action runner.
 * Every submit becomes one ActionPlan: a fresh execution-identical quote
 * (the router's own quoteIssue + the hook-aware V4Quoter), the gUSD or GPU
 * approval when the allowance is short, a pre-signature simulation, and
 * reconciliation of the account store on confirmation. The account view
 * projects the interim onchain account store (the Ponder successor lands
 * later) — never demo capital, never invented cost basis.
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
import { fmtAddress, fmtUnits } from "@/domain/format";
import { parseGpuUnits, parseGusd } from "@/domain/units";
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
import { buySpec, sellSpec } from "./specs";

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
      // The router pulls the full cap and refunds the change — the exact
      // cap is the honest ask, never max.
      const need = await planApproval(
        getContracts().addresses.gusd as Address,
        "gUSD",
        getContracts().addresses.router as Address,
        "router",
        owner,
        parseGusd(quote.maxPaid),
      );
      if (need) approvals.push(need);
    } else {
      const reg = await this.quoteDeps.reads.registration(gpuId);
      if (!reg) throw new Error(NO_QUOTE);
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
      poolGpuOut: parseGpuUnits(quote.legs.pool),
      issueGpuOut: parseGpuUnits(quote.legs.issuance),
      payment: getContracts().addresses.gusd as Address,
      maxPaid: parseGusd(quote.maxPaid),
      sqrtLimitX96: 0n,
    });
    const sellStruct = () => ({
      gpuId,
      gpuIn: sizeRaw,
      payout: getContracts().addresses.gusd as Address,
      minOut: parseGusd(quote.minOut),
      sqrtLimitX96: 0n,
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
            poolLeg: quote.legs.pool,
            issuanceLeg: quote.legs.issuance,
          }
        : { size: quote.size, minOut: quote.minOut, notional: quote.notional },
  };
}

/** The onchain snapshot → the Account vocabulary the shell already renders. */
function projectAccount(snap: {
  address: string | null;
  gUsd: number;
  sGusd: number;
  usdc: number;
  positions: readonly { gpuId: `0x${string}`; asset: AssetId | null; size: number }[];
}): Account {
  return {
    connected: snap.address !== null,
    label: snap.address ? fmtAddress(snap.address) : null,
    address: snap.address,
    gUsdBalance: snap.gUsd,
    sGUsdBalance: snap.sGusd,
    usdcBalance: snap.usdc,
    // Pre-indexer there is no cost-basis source: avgEntry stays null and
    // the UI prints "—" rather than a fabricated 0.
    positions: snap.positions.flatMap((p) =>
      p.asset ? [{ asset: p.asset, size: p.size, avgEntry: null }] : [],
    ),
  };
}
