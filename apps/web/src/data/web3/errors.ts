/**
 * Error normalization — every failure a user action can hit, in one voice.
 * The design system's Error Voice Rule speaks amber (function/attention),
 * never red (red is quarantined for market direction), so every string here
 * is written for the amber validation slot: what happened, what to do next.
 *
 * Sources layered:
 *   1. viem's ABI-decoded custom errors (data.errorName) → contract map
 *   2. EIP-1193/viem user rejection (via isUserRejection)
 *   3. raw message heuristics (provider strings vary)
 *   4. product-generic fallback
 */

import { isUserRejection } from "./wallet-client";
import { ERC20_ERRORS } from "./abis/erc20";

export interface NormalizedError {
  /** Amber-voiced message for the UI's validation/error slot. */
  voice: string;
  /** True when retrying the same action can plausibly succeed. */
  retryable: boolean;
  /** The contract custom error name, when one decoded. */
  errorName: string | null;
}

const GENERIC_RETRY = "The transaction didn't go through. Try again in a moment.";
const GENERIC = { voice: GENERIC_RETRY, retryable: true };

/** Contract custom errors → product voice. Anything unlisted falls through
 *  to the generic voice; internal-only errors (NotPoolManager, LegMismatch,
 *  DustLeft — invariants, never user mistakes) map to the fallback too. */
const ERROR_VOICE: Record<string, { voice: string; retryable: boolean }> = {
  // GpuRouter
  ZeroAmount: { voice: "Enter an amount greater than zero.", retryable: true },
  ZeroGpuOut: { voice: "Enter an amount greater than zero.", retryable: true },
  MaxPaidExceeded: {
    voice: "The price moved past your limit — review the new quote and try again.",
    retryable: true,
  },
  Slippage: {
    voice: "Execution fell below your minimum — the market moved. Try again.",
    retryable: true,
  },
  PoolShortfall: {
    voice: "The market couldn't absorb that size — reduce the amount.",
    retryable: true,
  },
  UnknownGpu: { voice: "This market isn't registered onchain yet.", retryable: false },
  NotCanonicalPool: {
    voice: "No canonical market exists for this asset yet — orders open when the market lands.",
    retryable: false,
  },
  UnsupportedPayment: {
    voice: "That payment asset isn't supported for this order.",
    retryable: false,
  },
  LegMismatch: { voice: GENERIC_RETRY, retryable: true },
  DustLeft: { voice: GENERIC_RETRY, retryable: true },
  NotPoolManager: { voice: GENERIC_RETRY, retryable: true },
  // GPUIssuance
  OracleStale: {
    voice: "The Index for this market is stale — issuance waits for a fresh publication.",
    retryable: true,
  },
  OraclePriceZero: {
    voice: "No Index price is published for this market yet.",
    retryable: true,
  },
  OracleFutureTimestamp: { voice: GENERIC_RETRY, retryable: true },
  IssuanceDisabled: {
    voice: "Issuance is disabled for this market — trade the secondary market instead.",
    retryable: false,
  },
  UnknownGpuId: { voice: "This market isn't registered onchain yet.", retryable: false },
  GpuAlreadyExists: { voice: GENERIC_RETRY, retryable: true },
  EmptyGpuId: { voice: "Enter an amount greater than zero.", retryable: true },
  GpuIdTooLong: { voice: GENERIC_RETRY, retryable: true },
  GpuIdNotLeftAligned: { voice: GENERIC_RETRY, retryable: true },
  InvalidGpuIdChar: { voice: GENERIC_RETRY, retryable: true },
  // GUSD
  EnforcedPause: {
    voice: "The protocol is paused by its operator — this action is unavailable right now.",
    retryable: true,
  },
  ExpectedPause: { voice: GENERIC_RETRY, retryable: true },
  ZeroNetAmount: {
    voice: "That amount nets to zero after fees — enter a larger amount.",
    retryable: true,
  },
  FeeTooLarge: { voice: GENERIC_RETRY, retryable: true },
  InvalidSink: { voice: GENERIC_RETRY, retryable: true },
  // sgUSD (ERC-4626)
  NotSeeded: {
    voice: "The earning layer hasn't been seeded by the protocol yet.",
    retryable: false,
  },
  ZeroShares: {
    voice: "That amount converts to zero shares — enter a larger amount.",
    retryable: true,
  },
  ERC4626ExceededMaxDeposit: {
    voice: "That deposit exceeds the vault's current limit.",
    retryable: false,
  },
  ERC4626ExceededMaxMint: {
    voice: "That mint exceeds the vault's current limit.",
    retryable: false,
  },
  ERC4626ExceededMaxWithdraw: {
    voice: "That withdrawal exceeds what the position allows right now.",
    retryable: false,
  },
  ERC4626ExceededMaxRedeem: {
    voice: "That redemption exceeds the position's balance.",
    retryable: false,
  },
  // GPUToken
  OnlyIssuer: { voice: GENERIC_RETRY, retryable: true },
  // OpenZeppelin ERC-20 (from any token in the path)
  ERC20InsufficientBalance: {
    voice: "The wallet's balance is too low for this order — check the amount.",
    retryable: true,
  },
  ERC20InsufficientAllowance: {
    voice: "The protocol needs a higher spending approval first — approve and retry.",
    retryable: true,
  },
  SafeERC20FailedOperation: {
    voice: "The token rejected the transfer — check the balance and approval.",
    retryable: true,
  },
  ERC20InvalidApprover: { voice: GENERIC_RETRY, retryable: true },
  ERC20InvalidSpender: { voice: GENERIC_RETRY, retryable: true },
  ERC20InvalidSender: { voice: GENERIC_RETRY, retryable: true },
  ERC20InvalidReceiver: { voice: GENERIC_RETRY, retryable: true },
};

/** The ERC-20 error names this module maps — kept as a value so the map's
 *  coverage is asserted in tests against the ABI source. */
export const MAPPED_ERC20_ERRORS = ERC20_ERRORS.map((e) => e.name);

export function normalizeActionError(err: unknown): NormalizedError {
  if (isUserRejection(err)) {
    return {
      voice: "Signature declined — nothing moved. Approve the request to continue.",
      retryable: true,
      errorName: null,
    };
  }

  const revert = findRevertData(err);
  if (revert) {
    const mapped = ERROR_VOICE[revert.errorName] ?? GENERIC;
    return { voice: mapped.voice, retryable: mapped.retryable, errorName: revert.errorName };
  }

  // Provider-level failures surface as strings; keep the lightest heuristic.
  const message = err instanceof Error ? err.message : String(err);
  if (/insufficient funds|exceeds balance|not enough/i.test(message)) {
    return {
      voice: "The wallet can't cover this — check the balance and gas.",
      retryable: true,
      errorName: null,
    };
  }

  console.error("[actions] unmapped error:", err);
  return { voice: GENERIC_RETRY, retryable: true, errorName: null };
}

/**
 * Walk viem's cause chain for the ABI-decoded revert: a
 * ContractFunctionRevertedError carries `data.errorName` + `data.args`.
 */
function findRevertData(err: unknown): { errorName: string; args?: unknown[] } | null {
  let cause: unknown = err;
  for (let depth = 0; cause instanceof Error && depth < 8; depth++) {
    const data = (cause as { data?: unknown }).data;
    if (
      data &&
      typeof data === "object" &&
      typeof (data as { errorName?: unknown }).errorName === "string"
    ) {
      const d = data as { errorName: string; args?: unknown[] };
      return { errorName: d.errorName, args: d.args };
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  return null;
}
