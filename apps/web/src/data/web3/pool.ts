/**
 * Canonical v4 pool derivation — the exact key the router computes
 * (apps/contracts/src/GpuRouter.sol::_canonicalKey) and the PoolId it
 * implies, built client-side so quotes, limits, and pool reads share one
 * derivation with the contracts. Currency ordering is plain address sort;
 * PoolId is keccak256(abi.encode(PoolKey)) per v4's PoolIdLibrary.
 */

import { encodeAbiParameters, keccak256, parseAbiParameters, type Address, type Hex } from "viem";

/** v4 PoolKey, currencies as plain addresses (Currency wrap is identity). */
export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** The canonical gUSD/GPU pool key for a registered gpuId. Mirrors
 *  _canonicalKey: pool params come from issuance, the hook from the
 *  deployment record, currencies sorted by address. */
export function canonicalPoolKey(
  gUsd: Address,
  gpuToken: Address,
  poolParams: { fee: number; tickSpacing: number },
  hook: Address,
): PoolKey {
  const [currency0, currency1] =
    gUsd.toLowerCase() < gpuToken.toLowerCase()
      ? [gUsd, gpuToken]
      : [gpuToken, gUsd];
  return {
    currency0,
    currency1,
    fee: Number(poolParams.fee),
    tickSpacing: Number(poolParams.tickSpacing),
    hooks: hook,
  };
}

/** PoolId = keccak256(abi.encode(poolKey)) — v4's identity for a pool. */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks"),
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/** BUY = gUSD → GPU: zeroForOne iff gUSD is currency0 (router parity). */
export function isBuyZeroForOne(key: PoolKey, gUsd: Address): boolean {
  return key.currency0.toLowerCase() === gUsd.toLowerCase();
}

/** The GPU side of the pool. */
export function gpuCurrencyOf(key: PoolKey, gUsd: Address): Address {
  return isBuyZeroForOne(key, gUsd) ? key.currency1 : key.currency0;
}
