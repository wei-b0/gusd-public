// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IGPUIssuance} from "../interfaces/IGPUIssuance.sol";

/// @title GpuPoolKey — canonical GPU/gUSD pool-key construction.
/// @notice Single source of truth for the canonical pool's currency ordering
///         (raw address sort) and the gUSD-side helper that liquidity
///         placement (GPUMarketLiquidity) needs to mirror the pool's
///         orientation. Shared by the router, the market-liquidity contract,
///         and deploy tooling so no consumer can disagree about the key.
library GpuPoolKey {
    /// @notice Canonical pool key for a GPU SKU: currencies sorted by raw
    ///         address, pool fee + tick spacing from the SKU's params.
    function canonical(address gUSD, address gpuToken, IGPUIssuance.PoolParams memory pp, IHooks hooks)
        internal
        pure
        returns (PoolKey memory key)
    {
        (Currency c0, Currency c1) = gUSD < gpuToken
            ? (Currency.wrap(gUSD), Currency.wrap(gpuToken))
            : (Currency.wrap(gpuToken), Currency.wrap(gUSD));
        key = PoolKey({currency0: c0, currency1: c1, fee: pp.fee, tickSpacing: pp.tickSpacing, hooks: hooks});
    }

    /// @notice True when gUSD is currency0 of the pool. Orientation decides
    ///         which side of the current tick a single-sided band must sit on:
    ///         with gUSD as currency0 a bid band (gUSD-only) sits ABOVE the
    ///         current tick; with gUSD as currency1, BELOW.
    function gusdIsCurrency0(PoolKey memory key, address gUSD) internal pure returns (bool) {
        return Currency.unwrap(key.currency0) == gUSD;
    }
}
