// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Narrow surface consumed by GPUHook and tooling.
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
}
