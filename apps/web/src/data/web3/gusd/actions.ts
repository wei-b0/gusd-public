/**
 * gUSD mint/redeem action builders — the contract-facing half of the mint
 * desk. Both flows are 6-decimal, 1:1-pegged pairs against the GUSD
 * contract: mintUSDC pulls USDC and mints gUSD net of the mint fee;
 * redeemUSDC burns the sender's gUSD and pays USDC net of the redeem fee.
 * The contract's preview functions are execution-identical, so a preview IS
 * the quote — nothing here estimates.
 */

import type { Address } from "viem";
import type { TxSpec } from "@/domain/types";
import { getContracts } from "../contracts";
import { contractReads } from "../reads";
import { GUSD_ABI } from "../abis/gusd";
import { planApproval, type ApprovalNeed } from "../approvals";
import { formatGusdRaw, formatUsdcRaw, parseGusd, parseUsdc } from "@/domain/units";

/** An execution-identical preview, product units. Fee is on the input. */
export interface GusdFlowQuote {
  /** Output after the fee — gUSD for mint, USDC for redeem. */
  output: number;
  fee: number;
  feeBps: number;
  paused: boolean;
}

/** Mint preview: USDC in → gUSD out. */
export async function quoteMint(usdcAmountRaw: bigint): Promise<GusdFlowQuote> {
  const { gusd } = getContracts();
  const reads = contractReads();
  const [gusdOutRaw, state] = await Promise.all([
    gusd.read.previewMintUSDC([usdcAmountRaw]),
    reads.gusdState(),
  ]);
  return {
    output: formatGusdRaw(gusdOutRaw),
    fee: formatUsdcRaw(usdcAmountRaw - gusdOutRaw),
    feeBps: state.mintFeeBps,
    paused: state.paused,
  };
}

/** Redeem preview: gUSD in → USDC out. */
export async function quoteRedeem(gusdAmountRaw: bigint): Promise<GusdFlowQuote> {
  const { gusd } = getContracts();
  const reads = contractReads();
  const [usdcOutRaw, state] = await Promise.all([
    gusd.read.previewRedeemUSDC([gusdAmountRaw]),
    reads.gusdState(),
  ]);
  return {
    output: formatUsdcRaw(usdcOutRaw),
    fee: formatGusdRaw(gusdAmountRaw - usdcOutRaw),
    feeBps: state.redeemFeeBps,
    paused: state.paused,
  };
}

/** The mint approval — USDC spend permission for the GUSD contract itself. */
export async function planMintApproval(
  owner: Address,
  usdcAmountRaw: bigint,
): Promise<ApprovalNeed | null> {
  const { addresses } = getContracts();
  return planApproval(
    addresses.usdc,
    "USDC",
    addresses.gusd,
    "gusd",
    owner,
    usdcAmountRaw,
  );
}

/** Mint gUSD from USDC. `to` is the session's own address. */
export function mintSpec(usdcAmountRaw: bigint, to: Address): TxSpec {
  return {
    origin: "mint",
    kind: "mint",
    async execute(wallet) {
      const hash = await wallet.writeContract({
        address: getContracts().addresses.gusd,
        abi: GUSD_ABI,
        functionName: "mintUSDC",
        args: [usdcAmountRaw, to],
        account: wallet.account ?? null,
        chain: null,
      });
      return { hash };
    },
  };
}

/** Redeem gUSD back to USDC — approval-free (the contract burns the sender). */
export function redeemSpec(gusdAmountRaw: bigint, to: Address): TxSpec {
  return {
    origin: "redeem",
    kind: "redeem",
    async execute(wallet) {
      const hash = await wallet.writeContract({
        address: getContracts().addresses.gusd,
        abi: GUSD_ABI,
        functionName: "redeemUSDC",
        args: [gusdAmountRaw, to],
        account: wallet.account ?? null,
        chain: null,
      });
      return { hash };
    },
  };
}

/** Parse a desk amount into 6-decimal raw units for the given direction. */
export function parseMintAmount(direction: "mint" | "redeem", amount: number): bigint {
  return direction === "mint" ? parseUsdc(amount) : parseGusd(amount);
}
