// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IMarketLiquidity — the surface GPUIssuance calls into.
/// @notice GPUIssuance forwards primary-buy principal to GPUMarketLiquidity,
///         which capitalizes the canonical GPU market with bid-side liquidity
///         around the oracle reference. The interface is intentionally
///         narrow: `notePrincipal` is pure accounting and must never fail on
///         v4 state, so a v4 problem can never take down primary issuance.
interface IMarketLiquidity {
    /// @notice Accounting entry: `amount` gUSD of primary-buy principal has
    ///         arrived for `gpuId` (physically transferred to this contract by
    ///         GPUIssuance before the call). Records the principal as pending;
    ///         placement into the pool is a separate, permissionless step
    ///         (`deployPending`).
    function notePrincipal(bytes32 gpuId, uint256 amount) external;

    /// @notice Places all pending principal for `gpuId` as a bid band in the
    ///         canonical pool. Permissionless; returns false (no-op) when the
    ///         pool does not exist yet, the reference is unplaceable right
    ///         now, or the amount is too small — pending principal is state,
    ///         not loss, and the next attempt retries.
    function deployPending(bytes32 gpuId) external returns (bool placed);
}
