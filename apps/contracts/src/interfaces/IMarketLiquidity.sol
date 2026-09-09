// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Narrow surface consumed by GPUHook and tooling.
interface IMarketLiquidity {
    /// @notice Bookkeeping-only: issuance has already transferred `amount`
    ///         gUSD to the vault. Books bid capacity + principal stat.
    ///         Caller must be the issuance contract.
    function notePrincipal(bytes32 gpuId, uint256 amount) external;

    /// @notice Bookkeeping-only: the hook has already taken `amount` GPU from
    ///         the PoolManager directly to the vault (take's `to` param).
    ///         Books ask-side inventory. Caller must be the hook.
    function noteGpu(bytes32 gpuId, uint256 amount) external;

    /// @notice Ask-side fill: move `amount` GPU from vault inventory to the
    ///         PoolManager. Caller must be the hook.
    function pullGpuToManager(bytes32 gpuId, uint256 amount) external;

    /// @notice Bid-side fill: move `amount` gUSD from vault bid inventory to
    ///         the PoolManager. Caller must be the hook.
    function pullGusdToManager(bytes32 gpuId, uint256 amount) external;

    /// @notice POL buy fills: the hook transfers gUSD proceeds to the vault
    ///         and books them as bid capacity. Caller must be the hook.
    function creditBidFromTrade(bytes32 gpuId, uint256 amount) external;

    /// @notice Per-SKU spendable bid capacity (gUSD-wei).
    function bidInventoryGusd(bytes32 gpuId) external view returns (uint256);

    /// @notice Per-SKU sellable ask inventory (GPU-wei).
    function askInventoryGpu(bytes32 gpuId) external view returns (uint256);

    /// @notice Cumulative primary principal capitalized per SKU (provenance
    ///         counter; never re-counted on recovery/migration).
    function principalContributed(bytes32 gpuId) external view returns (uint256);

    /// @notice The one address allowed to drive fills and in-swap issuance
    ///         (the GPUHook). Zero until `setRefs` wires it — fail-closed.
    function hook() external view returns (address);
}
