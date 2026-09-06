/**
 * The real earn port — gUSD ⇄ sGUSD through the shared action runner. Every
 * submit becomes one ActionPlan: pre-validation (session, seed gate, caps,
 * balance), the gUSD→sgUSD approval when the allowance is short (deposits
 * only), a pre-signature simulation, and reconciliation of the account
 * store on confirmation. Previews stay public; acting needs the session.
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
import { contractReads } from "../reads";
import { simulateWrite } from "../simulate";
import { SGUSD_ABI } from "../abis/sgusd";
import { getContracts } from "../contracts";
import {
  depositSpec,
  formatShares,
  parseEarnAmount,
  planEarnApproval,
  quoteDeposit,
  quoteWithdraw,
  withdrawSpec,
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
    this.reads = deps.reads ?? contractReads();
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

  async quote(direction: EarnDirection, gUsd: number): Promise<EarnQuote | null> {
    if (!Number.isFinite(gUsd) || gUsd <= 0) return null;
    const raw = parseEarnAmount(gUsd);
    if (raw <= 0n) return null;
    const sharesRaw = direction === "stake" ? await quoteDeposit(raw) : await quoteWithdraw(raw);
    return { direction, input: gUsd, shares: formatShares(sharesRaw) };
  }

  async deposit(gUsd: number): Promise<ActionRecord> {
    return this.run("stake", gUsd);
  }

  async withdraw(gUsd: number): Promise<ActionRecord> {
    return this.run("unstake", gUsd);
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
    if (direction === "stake") {
      if (state.maxDeposit !== MAX_UINT256 && raw > state.maxDeposit) {
        throw new Error("That deposit exceeds the vault's current deposit cap — check the amount.");
      }
    } else if (raw > state.maxWithdraw) {
      throw new Error(
        "That unstake is more than this position can pay out right now — check the amount.",
      );
    }

    // Balance pre-checks: the amber answer before the wallet is ever asked.
    // Unstake is assets-denominated, so the input is sized in shares.
    const { gusd: gusdAddress, sgusd: sgusdAddress } = getContracts().addresses;
    if (direction === "stake") {
      const gusdHeld = await this.reads.balanceOf(gusdAddress, owner);
      if (gusdHeld < raw) {
        throw new Error("The wallet's gUSD balance is too low for this stake — check the amount.");
      }
    } else {
      const sharesNeeded = await quoteWithdraw(raw);
      const sharesHeld = await this.reads.balanceOf(sgusdAddress, owner);
      if (sharesHeld < sharesNeeded) {
        throw new Error(
          "The wallet's sGUSD balance is too low for this unstake — check the amount.",
        );
      }
    }

    const approvals = [];
    if (direction === "stake") {
      const need = await planEarnApproval(owner, raw);
      if (need) approvals.push(need);
    }

    const sharesRaw =
      direction === "stake" ? await quoteDeposit(raw) : await quoteWithdraw(raw);
    const label =
      direction === "stake"
        ? `Stake ${fmtGusdLedger(amount)} gUSD`
        : `Unstake ${fmtGusdLedger(amount)} gUSD`;

    const plan: ActionPlan = {
      origin: direction === "stake" ? "earn" : "unearn",
      label,
      quote: snapshot(amount, formatShares(sharesRaw)),
      approvals,
      simulate: async () => {
        const { sgusd } = getContracts();
        const result = await simulateWrite({
          address: sgusd.address,
          abi: SGUSD_ABI,
          functionName: direction === "stake" ? "deposit" : "withdraw",
          args: direction === "stake" ? [raw, owner] : [raw, owner, owner],
          account: owner,
        });
        return result.ok ? result : { ok: false, error: result.error.voice };
      },
      buildSpec: () =>
        direction === "stake" ? depositSpec(raw, owner) : withdrawSpec(raw, owner),
      reconcile: this.deps.reconcile,
    };

    return this.deps.actions.run(plan);
  }

  private set(next: EarnState): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

function snapshot(input: number, shares: number): QuoteSnapshot {
  return {
    quotedAtMs: Date.now(),
    blockNumber: null,
    totals: { input, shares },
  };
}
