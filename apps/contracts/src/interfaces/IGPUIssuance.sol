// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Narrow surface consumed by GPUHook, GPUMarketLiquidity, and tooling.
interface IGPUIssuance {
    /// @notice Canonical pool parameters for a GPU SKU.
    struct PoolParams {
        uint24 fee;
        int24 tickSpacing;
    }

    /// @return gpuId 0 if `token` is not a registered GPU token.
    function gpuIdOfToken(address token) external view returns (bytes32 gpuId);

    /// @notice Reverts UnknownGpuId if unregistered.
    function poolParamsOf(bytes32 gpuId) external view returns (PoolParams memory);

    function isIssuanceEnabled(bytes32 gpuId) external view returns (bool);

    function tokenOf(bytes32 gpuId) external view returns (address);

    /// @notice POL band depth in ticks (reverts UnknownGpuId if unregistered).
    function bandWidthOf(bytes32 gpuId) external view returns (int24);

    /// @notice POL bid-band spread below the issuance ask, in ticks (reverts
    ///         UnknownGpuId if unregistered).
    function bandSpreadTicksOf(bytes32 gpuId) external view returns (int24);

    /// @notice Issuance fee in bps (reverts UnknownGpuId if unregistered).
    function feeBpsOf(bytes32 gpuId) external view returns (uint16);

    /// @notice Current oracle reference price as a gUSD-wei-per-GPU-wei
    ///         sqrtPriceX96, with the full staleness guard set `issue()`
    ///         applies (reverts on an unpublished or stale oracle). Nothing is
    ///         ever placed at a stale reference.
    function referenceSqrtPriceX96(bytes32 gpuId) external view returns (uint256);
}
