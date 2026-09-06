/**
 * sGUSD earn action builders — the contract-facing half of the earn desk.
 * The vault is a fee-free ERC-4626 over gUSD (6 decimals both sides), so a
 * preview IS the quote: deposit mints `previewDeposit(assets)` shares,
 * withdraw burns `previewWithdraw(assets)` shares. The share price is the
 * yield — nothing here invents a rate.
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

/** Unstake preview: gUSD out → sgUSD burned. */
export async function quoteWithdraw(gusdRaw: bigint): Promise<bigint> {
  const { sgusd } = getContracts();
  return sgusd.read.previewWithdraw([gusdRaw]);
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

/** Withdraw gUSD from the vault, burning sgUSD from `to`. Approval-free. */
export function withdrawSpec(gusdRaw: bigint, to: Address): TxSpec {
  return {
    origin: "unearn",
    kind: "earn-withdraw",
    async execute(wallet) {
      const hash = await wallet.writeContract({
        address: getContracts().addresses.sgusd,
        abi: SGUSD_ABI,
        functionName: "withdraw",
        args: [gusdRaw, to, to],
        account: wallet.account ?? null,
        chain: null,
      });
      return { hash };
    },
  };
}

/** Parse a desk amount into 6-decimal raw gUSD (both vault sides are 6dp). */
export function parseEarnAmount(gusd: number): bigint {
  return parseGusd(gusd);
}

/** Raw sgUSD shares → product units (6 decimals, same as gUSD). */
export function formatShares(sharesRaw: bigint): number {
  return formatGusdRaw(sharesRaw);
}
