/**
 * The real mint port — the chain's funding stables ⇄ gUSD through the
 * shared action runner. Every submit becomes one ActionPlan: pre-validation
 * (session, pause, balance), the funding-asset approval when the allowance
 * is short (mint only — reserve path lands on GUSD, others on the
 * StableRouter), a pre-signature simulation, and reconciliation of the
 * account store on confirmation. Previews stay public; acting needs the
 * session. `asset` is always a StableRouter-whitelisted address from the
 * deployment record — the desk never passes a symbol or an unvetted token.
 */

import type { Address } from "viem";
import type { ActionPort } from "@/domain/ports";
import type { ActionPlan, ActionRecord, QuoteSnapshot } from "@/domain/actions";
import type { MintPort } from "@/domain/ports";
import type { MintDirection, MintQuote } from "@/domain/types";
import { fmtGusdLedger } from "@/domain/format";
import { formatGusdRaw, formatStableRaw } from "@/domain/units";
import type { ContractReads } from "../reads";
import { contractReads } from "../reads";
import { simulateWrite } from "../simulate";
import { GUSD_ABI } from "../abis/gusd";
import { STABLE_ROUTER_ABI } from "../abis/stable_router";
import { getContracts } from "../contracts";
import { stableMetaOf } from "../stables";
import {
  parseMintAmount,
  planMintApproval,
  quoteMint,
  quoteRedeem,
  quoteMintViaStable,
  quoteRedeemViaStable,
  mintSpec,
  redeemSpec,
  stablePoolKey,
  type GusdFlowQuote,
  type StableMintQuote,
  type StableRedeemQuote,
} from "./actions";

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

/** The port's one internal quote — raw values for the spec, product values
 *  for the desk. `viaSwap` quotes carry the signed floors; a null means no
 *  funding pool prices the route. */
type ResolvedQuote =
  | { viaSwap: false; q: GusdFlowQuote; isReserve: true }
  | { viaSwap: false; q: GusdFlowQuote; isReserve: false }
  | { viaSwap: true; q: StableMintQuote | StableRedeemQuote; isReserve: false };

export class OnChainMintPort implements MintPort {
  private readonly reads: ContractReads;

  constructor(private readonly deps: OnChainMintPortDeps) {
    this.reads = deps.reads ?? contractReads();
  }

  async quote(direction: MintDirection, asset: Address, amount: number): Promise<MintQuote | null> {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const raw = parseMintAmount(direction, amount);
    if (raw <= 0n) return null;
    const resolved = await this.resolveQuote(direction, asset, raw);
    if (!resolved) return null;
    return this.toMintQuote(direction, asset, amount, resolved);
  }

  async mint(asset: Address, amount: number): Promise<ActionRecord> {
    return this.run("mint", asset, amount);
  }

  async redeem(asset: Address, gusdAmount: number): Promise<ActionRecord> {
    return this.run("redeem", asset, gusdAmount);
  }

  private async resolveQuote(
    direction: MintDirection,
    asset: Address,
    raw: bigint,
  ): Promise<ResolvedQuote | null> {
    const { addresses } = getContracts();
    const isReserve = asset.toLowerCase() === (addresses.underlying as Address).toLowerCase();
    if (isReserve) {
      const q = direction === "mint" ? await quoteMint(raw) : await quoteRedeem(raw);
      return { viaSwap: false, q, isReserve: true };
    }
    if (direction === "mint") {
      const q = await quoteMintViaStable(asset, raw);
      return q ? { viaSwap: true, q, isReserve: false } : null;
    }
    const q = await quoteRedeemViaStable(asset, raw);
    return q ? { viaSwap: true, q, isReserve: false } : null;
  }

  private toMintQuote(
    direction: MintDirection,
    asset: Address,
    amount: number,
    resolved: ResolvedQuote,
  ): MintQuote {
    if (!resolved.viaSwap) {
      const q = resolved.q;
      return {
        direction,
        asset,
        input: amount,
        output: direction === "mint" ? formatGusdRaw(q.outputRaw) : formatStableRaw(q.outputRaw),
        fee: formatGusdRaw(q.feeRaw),
        feeBps: q.feeBps,
        paused: q.paused,
        viaSwap: false,
        minOutput: null,
      };
    }
    if (direction === "mint") {
      const s = resolved.q as StableMintQuote;
      return {
        direction,
        asset,
        input: amount,
        output: formatGusdRaw(s.gusdOutRaw),
        fee: formatGusdRaw(s.underlyingInRaw - s.gusdOutRaw),
        feeBps: s.feeBps,
        paused: s.paused,
        viaSwap: true,
        minOutput: formatGusdRaw(s.minUnderlyingRaw),
      };
    }
    const s = resolved.q as StableRedeemQuote;
    return {
      direction,
      asset,
      input: amount,
      output: formatStableRaw(s.stableOutRaw),
      fee: formatGusdRaw(s.gusdInRaw - s.underlyingOutRaw),
      feeBps: s.feeBps,
      paused: s.paused,
      viaSwap: true,
      minOutput: formatStableRaw(s.minStableRaw),
    };
  }

  private async run(direction: MintDirection, asset: Address, amount: number): Promise<ActionRecord> {
    const session = this.deps.getSession();
    if (session.status !== "connected" || !session.address) {
      throw new Error(NO_SESSION);
    }
    const owner = session.address as `0x${string}`;
    const raw = parseMintAmount(direction, amount);
    if (!Number.isFinite(amount) || raw <= 0n) {
      throw new Error("Enter an amount greater than zero.");
    }
    const symbol = stableMetaOf(asset)?.symbol ?? "the funding asset";

    // Quote first: it carries the pause state and (swap path) the signed
    // floors. A null swap quote means no funding pool exists — fail here,
    // before the wallet is ever asked.
    const resolved = await this.resolveQuote(direction, asset, raw);
    if (!resolved) {
      throw new Error(
        direction === "mint"
          ? `No funding pool prices ${symbol} → gUSD yet — LP depth has to exist before this mint routes.`
          : `No funding pool prices gUSD → ${symbol} yet — LP depth has to exist before this redemption routes.`,
      );
    }
    const q = this.toMintQuote(direction, asset, amount, resolved);
    if (q.paused) {
      throw new Error(
        direction === "mint"
          ? "Minting is paused by the protocol operator — try again later."
          : "Redemption is paused by the protocol operator — try again later.",
      );
    }

    // Balance pre-check: the amber answer before the wallet is ever asked.
    const { addresses } = getContracts();
    const balanceRaw =
      direction === "mint"
        ? await this.reads.balanceOf(asset, owner)
        : await this.reads.balanceOf(addresses.gusd, owner);
    if (balanceRaw < raw) {
      throw new Error(
        direction === "mint"
          ? `The wallet's ${symbol} balance is too low for this mint — check the amount.`
          : "The wallet's gUSD balance is too low for this redemption — check the amount.",
      );
    }

    const approvals = [];
    if (direction === "mint") {
      const need = await planMintApproval(owner, asset, raw);
      if (need) approvals.push(need);
    }

    const label =
      direction === "mint"
        ? q.viaSwap
          ? `Mint ${fmtGusdLedger(q.output)} gUSD via ${symbol}`
          : `Mint ${fmtGusdLedger(q.output)} gUSD`
        : q.viaSwap
          ? `Redeem ${fmtGusdLedger(amount)} gUSD to ${symbol}`
          : `Redeem ${fmtGusdLedger(amount)} gUSD`;

    const poolKey = resolved.viaSwap ? stablePoolKey(asset, addresses.underlying as Address) : null;
    const plan: ActionPlan = {
      origin: direction === "mint" ? "mint" : "redeem",
      label,
      quote: snapshot(amount, q.output, q.fee),
      approvals,
      simulate: async () => {
        const result = resolved.viaSwap
          ? await simulateWrite({
              address: addresses.stableRouter,
              abi: STABLE_ROUTER_ABI,
              functionName: direction === "mint" ? "mint" : "redeem",
              args:
                direction === "mint"
                  ? [asset, raw, (resolved.q as StableMintQuote).minUnderlyingRaw, poolKey, owner]
                  : [asset, raw, (resolved.q as StableRedeemQuote).minStableRaw, poolKey, owner],
              account: owner,
            })
          : await simulateWrite({
              address: addresses.gusd,
              abi: GUSD_ABI,
              functionName: direction === "mint" ? "mint" : "redeem",
              args: [raw, owner],
              account: owner,
            });
        return result.ok ? result : { ok: false, error: result.error.voice };
      },
      buildSpec: () =>
        resolved.viaSwap
          ? direction === "mint"
            ? mintSpec({
                asset,
                amountInRaw: raw,
                minUnderlyingOutRaw: (resolved.q as StableMintQuote).minUnderlyingRaw,
                poolKey,
                to: owner,
              })
            : redeemSpec({
                asset,
                gusdInRaw: raw,
                minStableOutRaw: (resolved.q as StableRedeemQuote).minStableRaw,
                poolKey,
                to: owner,
              })
          : direction === "mint"
            ? mintSpec({ asset, amountInRaw: raw, minUnderlyingOutRaw: raw, poolKey, to: owner })
            : redeemSpec({ asset, gusdInRaw: raw, minStableOutRaw: 0n, poolKey, to: owner }),
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
