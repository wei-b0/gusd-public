/**
 * Approval planning and specs — the ERC-20 allowance primitive every flow
 * builds on. Approvals run as their own session transactions (kind
 * "approve") so the user sees, signs, and can decline exactly one spend
 * permission per action. Amounts are the exact needed figure, never max:
 * the router refunds unconsumed funds by design, and an honest desk asks
 * for what it needs.
 */

import { encodeFunctionData, type Address } from "viem";
import type { ApprovalNeed, SpenderKind } from "@/domain/actions";
import type { TxSpec } from "@/domain/types";
import { getContracts, erc20Client } from "./contracts";
import { ERC20_ABI } from "./abis/erc20";

/** The approval vocabulary lives in the domain (the desks render it); this
 *  module owns turning a need into a read, a spec, and calldata. */
export type { ApprovalNeed, SpenderKind };

/**
 * Null when the allowance already covers `needed`; otherwise the discrete
 * approval step the UI renders before the action itself.
 */
export async function planApproval(
  token: Address,
  tokenLabel: string,
  spender: Address,
  spenderKind: SpenderKind,
  owner: Address,
  needed: bigint,
): Promise<ApprovalNeed | null> {
  const current = await erc20Client(token).read.allowance([owner, spender]);
  if (current >= needed) return null;
  return { token, tokenLabel, spender, spenderKind, amount: needed };
}

/** The approval TxSpec. `origin` mirrors the action it serves so session
 *  ledgers group the pair. */
export function approveSpec(need: ApprovalNeed, origin: string): TxSpec {
  return {
    origin,
    kind: "approve",
    async execute(wallet) {
      // viem's writeContract resolves to the hash itself, not a receipt object.
      const hash = await wallet.writeContract({
        address: need.token,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [need.spender, need.amount],
        // The session pre-flight guarantees a signer; the client carries the
        // account, but the broad WalletClient type wants it stated.
        account: wallet.account ?? null,
        chain: null,
      });
      return { hash };
    },
  };
}

/** Spender resolution from the deployment record — no address literals. */
export function spenderAddress(kind: SpenderKind): Address {
  const { addresses } = getContracts();
  switch (kind) {
    case "router":
      return addresses.router as Address;
    case "gusd":
      return addresses.gusd as Address;
    case "sgusd":
      return addresses.sgusd as Address;
    case "stableRouter":
      return addresses.stableRouter as Address;
  }
}

/** Calldata helper for simulation inputs that pair an approve with an action. */
export function approveCalldata(need: ApprovalNeed): `0x${string}` {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [need.spender, need.amount],
  });
}
