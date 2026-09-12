/**
 * The real earn port — gUSD ⇄ sgUSD through the shared action runner. Every
 * submit becomes one ActionPlan: pre-validation (session, seed gate, caps,
 * balance), the gUSD→sgUSD approval when the allowance is short (deposits
 * only), a pre-signature simulation, and reconciliation of the account
 * store on confirmation. Previews stay public; acting needs the session.
 * Stakes are assets-first, redeems shares-first — each input names the leg
 * the wallet signs for.
 *
 * The vault's public facts (share price, seed gate) ride a small snapshot
 * store so useEarn() keeps its shape; the share price is the yield — there
 * is deliberately no APY figure anywhere.
 */

import type { Address } from "viem";
import type { ActionPort, EarnPort } from "@/domain/ports";
import type { ActionPlan, ActionRecord, QuoteSnapshot } from "@/domain/actions";
import type { EarnDirection, EarnQuote, EarnState } from "@/domain/types";
import { fmtGusdLedger } from "@/domain/format";
import type { ContractReads } from "../reads";
import { contractReadsWithIndexer } from "../reads-protocol";
import { simulateWrite } from "../simulate";
import { SGUSD_ABI } from "../abis/sgusd";
import { getContracts } from "../contracts";
import {
  depositSpec,
  formatShares,
  parseEarnAmount,
  planEarnApproval,
  quoteDeposit,
  quoteRedeem,
  redeemSpec,
} from "./actions";

export interface OnChainEarnPortDeps {
  /** The session source — the port refuses to act without one. */
  getSession(): { status: string; address: string | null };
  actions: ActionPort;
  /** Post-confirmation refresh (the account store). */
  reconcile?: (txIds: readonly string[]) => Promise<unknown>;
  /** Read seam, injectable for tests. */
  reads?: ContractReads;
}

const NO_SESSION = "Connect a wallet to earn — nothing signs without one.";

const MAX_UINT256 = 2n ** 256n - 1n;

export class OnChainEarnPort implements EarnPort {
  private readonly reads: ContractReads;
  private snapshot: EarnState = { rate: null, seeded: null, updatedAt: null };
  private listeners = new Set<() => void>();
  private refreshing: Promise<void> | null = null;

  constructor(private readonly deps: OnChainEarnPortDeps) {
    this.reads = deps.reads ?? contractReadsWithIndexer();
  }

  getEarnState(): EarnState {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    const first = this.listeners.size === 0;
    this.listeners.add(listener);
    // First subscriber pulls the vault facts; later ones inherit the snapshot.
    if (first) void this.refresh();
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Re-read the vault's public facts (share price, seed gate). */
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        // Owner-scoped caps are read at action time; the snapshot is public.
        const zero = "0x0000000000000000000000000000000000000000" as Address;
        const state = await this.reads.sgusdState(zero);
        const settled =
          this.snapshot.updatedAt !== null &&
          this.snapshot.rate === state.rate &&
          this.snapshot.seeded === state.seeded;
        if (!settled) {
          this.set({ rate: state.rate, seeded: state.seeded, updatedAt: Date.now() });
        }
      } catch (err) {
        // Read failure is a system problem, not a user failure: keep the
        // last snapshot, log for the operator.
        console.error("[earn-port] vault read failed:", err);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async quote(direction: EarnDirection, amount: number): Promise<EarnQuote | null> {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const raw = parseEarnAmount(amount);
    if (raw <= 0n) return null;
    if (direction === "stake") {
      const sharesRaw = await quoteDeposit(raw);
      return { direction, input: amount, assets: amount, shares: formatShares(sharesRaw) };
    }
    // Redeem is shares-first: the input names the shares, the preview
    // prices the gUSD leg that comes back.
    const assetsRaw = await quoteRedeem(raw);
    return { direction, input: amount, assets: formatShares(assetsRaw), shares: formatShares(raw) };
  }

  async deposit(gUsd: number): Promise<ActionRecord> {
    return this.run("stake", gUsd);
  }

  async redeem(shares: number): Promise<ActionRecord> {
    return this.run("unstake", shares);
  }

  private async run(direction: EarnDirection, amount: number): Promise<ActionRecord> {
    const session = this.deps.getSession();
    if (session.status !== "connected" || !session.address) {
      throw new Error(NO_SESSION);
    }
    const owner = session.address as Address;
    const raw = parseEarnAmount(amount);
    if (!Number.isFinite(amount) || raw <= 0n) {
      throw new Error("Enter an amount greater than zero.");
    }

    const state = await this.reads.sgusdState(owner);
    if (!state.seeded) {
      throw new Error("The vault hasn't been seeded yet — deposits open once it holds its seed.");
    }
    // Redeem previews its gUSD leg once — the preview sizes the withdraw
    // cap below and rides into the plan's quote snapshot.
    let assetsRaw = raw;
    if (direction === "stake") {
      if (state.maxDeposit !== MAX_UINT256 && raw > state.maxDeposit) {
        throw new Error("That deposit exceeds the vault's current deposit cap — check the amount.");
      }
    } else {
      assetsRaw = await quoteRedeem(raw);
      if (assetsRaw > state.maxWithdraw) {
        throw new Error(
          "That unstake is more than this position can pay out right now — check the amount.",
        );
      }
    }

    // Balance pre-checks: the amber answer before the wallet is ever asked.
    // Redeem is shares-denominated — the input IS the share amount.
    const { gusd: gusdAddress, sgusd: sgusdAddress } = getContracts().addresses;
    if (direction === "stake") {
      const gusdHeld = await this.reads.balanceOf(gusdAddress, owner);
      if (gusdHeld < raw) {
        throw new Error("The wallet's gUSD balance is too low for this stake — check the amount.");
      }
    } else {
      const sharesHeld = await this.reads.balanceOf(sgusdAddress, owner);
      if (sharesHeld < raw) {
        throw new Error(
          "The wallet's sgUSD balance is too low for this unstake — check the amount.",
        );
      }
    }

    const approvals = [];
    if (direction === "stake") {
      const need = await planEarnApproval(owner, raw);
      if (need) approvals.push(need);
    }

    const sharesRaw = direction === "stake" ? await quoteDeposit(raw) : raw;
    const label =
      direction === "stake"
        ? `Stake ${fmtGusdLedger(amount)} gUSD`
        : `Unstake ${fmtGusdLedger(amount)} sgUSD`;

    const plan: ActionPlan = {
      origin: direction === "stake" ? "earn" : "unearn",
      label,
      quote: snapshot(
        amount,
        direction === "stake" ? amount : formatShares(assetsRaw),
        formatShares(sharesRaw),
      ),
      approvals,
      simulate: async () => {
        const { sgusd } = getContracts();
        const result = await simulateWrite({
          address: sgusd.address,
          abi: SGUSD_ABI,
          functionName: direction === "stake" ? "deposit" : "redeem",
          args: direction === "stake" ? [raw, owner] : [raw, owner, owner],
          account: owner,
        });
        return result.ok ? result : { ok: false, error: result.error.voice };
      },
      buildSpec: () =>
        direction === "stake" ? depositSpec(raw, owner) : redeemSpec(raw, owner),
      reconcile: this.deps.reconcile,
    };

    return this.deps.actions.run(plan);
  }

  private set(next: EarnState): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

function snapshot(input: number, assets: number, shares: number): QuoteSnapshot {
  return {
    quotedAtMs: Date.now(),
    blockNumber: null,
    totals: { input, assets, shares },
  };
}
