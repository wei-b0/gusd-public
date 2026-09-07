/**
 * Pure transfer-leg math — the signed balance deltas one ERC-20 Transfer
 * event produces. Mint legs (from = zero) credit the receiver only; burn
 * legs (to = zero) debit the sender only; the zero address itself never
 * becomes a wallet row. Handlers apply each delta through
 * wallet-state.applyBalanceDelta inside Ponder's per-event transaction.
 */

import type { Address } from "viem";

/** The zero address — ERC-20 mint/burn endpoint. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface BalanceChange {
  wallet: Address;
  delta: bigint;
}

/** Signed deltas for one Transfer. A self-transfer yields both legs (net
 *  zero, two transferCount stamps); a zero→zero transfer yields none. */
export function balanceChanges(transfer: {
  from: Address;
  to: Address;
  value: bigint;
}): BalanceChange[] {
  const isMint = transfer.from.toLowerCase() === ZERO_ADDRESS;
  const isBurn = transfer.to.toLowerCase() === ZERO_ADDRESS;
  if (isMint && isBurn) return [];
  if (isMint) return [{ wallet: transfer.to, delta: transfer.value }];
  if (isBurn) return [{ wallet: transfer.from, delta: -transfer.value }];
  return [
    { wallet: transfer.from, delta: -transfer.value },
    { wallet: transfer.to, delta: transfer.value },
  ];
}
