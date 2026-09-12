/**
 * sgUSD earn action builders — the contract-facing half of the earn desk.
 * The vault is a fee-free ERC-4626 over gUSD (6 decimals both sides), so a
 * preview IS the quote: deposit mints `previewDeposit(assets)` shares,
 * redeem burns exactly the shares asked and pays `previewRedeem(shares)`
 * assets. The share price is the yield — nothing here invents a rate.
 */

import type { Address } from "viem";
import type { TxSpec } from "@/domain/types";
import { getContracts } from "../contracts";
import { SGUSD_ABI } from "../abis/sgusd";
import { planApproval, type ApprovalNeed } from "../approvals";
import { formatGusdRaw, parseGusd } from "@/domain/units";

/** Stake preview: gUSD in → sgUSD minted. */
export async function quoteDeposit(gusdRaw: bigint): Promise<bigint> {
  const { sgusd } = getContracts();
  return sgusd.read.previewDeposit([gusdRaw]);
}

/** Unstake preview, shares-first: gUSD out for `sharesRaw` burned. */
export async function quoteRedeem(sharesRaw: bigint): Promise<bigint> {
  const { sgusd } = getContracts();
  return sgusd.read.previewRedeem([sharesRaw]);
}

/** The deposit approval — gUSD spend permission for the sgUSD vault. */
export async function planEarnApproval(
  owner: Address,
  gusdRaw: bigint,
): Promise<ApprovalNeed | null> {
  const { addresses } = getContracts();
  return planApproval(addresses.gusd, "gUSD", addresses.sgusd, "sgusd", owner, gusdRaw);
}

/** Deposit gUSD into the vault, minting sgUSD to `to`. */
export function depositSpec(gusdRaw: bigint, to: Address): TxSpec {
  return {
    origin: "earn",
    kind: "earn-deposit",
    async execute(wallet) {
      const hash = await wallet.writeContract({
        address: getContracts().addresses.sgusd,
        abi: SGUSD_ABI,
        functionName: "deposit",
        args: [gusdRaw, to],
        account: wallet.account ?? null,
        chain: null,
      });
      return { hash };
    },
  };
}

/** Redeem sgUSD shares from the vault for gUSD to `to`. Approval-free. */
export function redeemSpec(sharesRaw: bigint, to: Address): TxSpec {
  return {
    origin: "unearn",
    kind: "earn-withdraw",
    async execute(wallet) {
      const hash = await wallet.writeContract({
        address: getContracts().addresses.sgusd,
        abi: SGUSD_ABI,
        functionName: "redeem",
        args: [sharesRaw, to, to],
        account: wallet.account ?? null,
        chain: null,
      });
      return { hash };
    },
  };
}

/** Parse a desk amount into 6-decimal raw units (both vault sides are 6dp,
 *  so this parses gUSD on stake and sgUSD shares on unstake alike). */
export function parseEarnAmount(amount: number): bigint {
  return parseGusd(amount);
}

/** Raw sgUSD shares → product units (6 decimals, same as gUSD). */
export function formatShares(sharesRaw: bigint): number {
  return formatGusdRaw(sharesRaw);
}
