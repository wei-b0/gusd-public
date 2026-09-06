/**
 * The real mint port — USDC ⇄ gUSD through the shared action runner. Every
 * submit becomes one ActionPlan: pre-validation (session, pause, balance),
 * the USDC→GUSD approval when the allowance is short (mint only), a
 * pre-signature simulation, and reconciliation of the account store on
 * confirmation. Previews stay public; acting needs the session.
 */

import type { ActionPort } from "@/domain/ports";
import type { ActionPlan, ActionRecord, QuoteSnapshot } from "@/domain/actions";
import type { MintPort } from "@/domain/ports";
import type { MintDirection, MintQuote } from "@/domain/types";
import { fmtGusdLedger } from "@/domain/format";
import type { ContractReads } from "../reads";
import { contractReads } from "../reads";
import { simulateWrite } from "../simulate";
import { GUSD_ABI } from "../abis/gusd";
import { getContracts } from "../contracts";
import { parseMintAmount, planMintApproval, quoteMint, quoteRedeem, mintSpec, redeemSpec } from "./actions";

export interface OnChainMintPortDeps {
  /** The session source — the port refuses to act without one. */
  getSession(): { status: string; address: string | null };
  actions: ActionPort;
  /** Post-confirmation refresh (the account store). */
  reconcile?: (txIds: readonly string[]) => Promise<unknown>;
  /** Read seam, injectable for tests. */
  reads?: ContractReads;
}

const NO_SESSION = "Connect a wallet to mint — nothing signs without one.";

export class OnChainMintPort implements MintPort {
  private readonly reads: ContractReads;

  constructor(private readonly deps: OnChainMintPortDeps) {
    this.reads = deps.reads ?? contractReads();
  }

  async quote(direction: MintDirection, amount: number): Promise<MintQuote | null> {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const raw = parseMintAmount(direction, amount);
    if (raw <= 0n) return null;
    const q = direction === "mint" ? await quoteMint(raw) : await quoteRedeem(raw);
    return {
      direction,
      input: amount,
      output: q.output,
      fee: q.fee,
      feeBps: q.feeBps,
      paused: q.paused,
    };
  }

  async mint(usdcAmount: number): Promise<ActionRecord> {
    return this.run("mint", usdcAmount);
  }

  async redeem(gusdAmount: number): Promise<ActionRecord> {
    return this.run("redeem", gusdAmount);
  }

  private async run(direction: MintDirection, amount: number): Promise<ActionRecord> {
    const session = this.deps.getSession();
    if (session.status !== "connected" || !session.address) {
      throw new Error(NO_SESSION);
    }
    const owner = session.address as `0x${string}`;
    const raw = parseMintAmount(direction, amount);
    if (!Number.isFinite(amount) || raw <= 0n) {
      throw new Error("Enter an amount greater than zero.");
    }

    const q = direction === "mint" ? await quoteMint(raw) : await quoteRedeem(raw);
    if (q.paused) {
      throw new Error(
        direction === "mint"
          ? "Minting is paused by the protocol operator — try again later."
          : "Redemption is paused by the protocol operator — try again later.",
      );
    }

    // Balance pre-check: the amber answer before the wallet is ever asked.
    const { gusd: gusdAddress, usdc: usdcAddress } = getContracts().addresses;
    const balanceRaw =
      direction === "mint"
        ? await this.reads.balanceOf(usdcAddress, owner)
        : await this.reads.balanceOf(gusdAddress, owner);
    if (balanceRaw < raw) {
      throw new Error(
        direction === "mint"
          ? "The wallet's USDC balance is too low for this mint — check the amount."
          : "The wallet's gUSD balance is too low for this redemption — check the amount.",
      );
    }

    const approvals = [];
    if (direction === "mint") {
      const need = await planMintApproval(owner, raw);
      if (need) approvals.push(need);
    }

    const label =
      direction === "mint"
        ? `Mint ${fmtGusdLedger(q.output)} gUSD`
        : `Redeem ${fmtGusdLedger(amount)} gUSD`;

    const plan: ActionPlan = {
      origin: direction === "mint" ? "mint" : "redeem",
      label,
      quote: snapshot(amount, q.output, q.fee),
      approvals,
      simulate: async () => {
        const { gusd } = getContracts();
        const result = await simulateWrite({
          address: gusd.address,
          abi: GUSD_ABI,
          functionName: direction === "mint" ? "mintUSDC" : "redeemUSDC",
          args: [raw, owner],
          account: owner,
        });
        return result.ok ? result : { ok: false, error: result.error.voice };
      },
      buildSpec: () =>
        direction === "mint" ? mintSpec(raw, owner) : redeemSpec(raw, owner),
      reconcile: this.deps.reconcile,
    };

    return this.deps.actions.run(plan);
  }
}

function snapshot(input: number, output: number, fee: number): QuoteSnapshot {
  return {
    quotedAtMs: Date.now(),
    blockNumber: null,
    totals: { input, output, fee },
  };
}
