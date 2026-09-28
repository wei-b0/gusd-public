// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IGpuOracle} from "../oracle/IGpuOracle.sol";

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

    /// @notice Issuance fee in bps (reverts UnknownGpuId if unregistered).
    function feeBpsOf(bytes32 gpuId) external view returns (uint16);

    /// @notice Derived composition divisor (PRICE_SCALE derivation, == 1e16
    ///         for the coordination-fixed 4-decimal price convention).
    function compositionDivisor() external view returns (uint256);

    /// @notice The wired pull oracle (report verifier/consumer).
    function oracle() external view returns (IGpuOracle);

    /// @notice Address of the market-liquidity vault principal routes into
    ///         (every issuance base payment lands there as bid capacity).
    function marketLiquidity() external view returns (address);

    /// @notice Reference sqrt for a verified report: applies the FULL oracle
    ///         acceptance set (current epoch, signature, binding bounds).
    function reportSqrtPriceX96(bytes32 gpuId, IGpuOracle.Report calldata report, bytes calldata signature)
        external
        view
        returns (uint256);

    /// @notice In-swap issuance backstop for GPUHook: identical pricing and
    ///         guard set to `issue()`, priced at the submitted report, paid by
    ///         transferFrom from the caller (the hook), minting to `to`.
    ///         Reverts when `base + fee > maxGusdSpend` (fail-closed, R2).
    function issueCredited(bytes32 gpuId, uint256 amount, address to, uint256 maxGusdSpend, bytes calldata updateData)
        external
        returns (uint256 base, uint256 fee);

    /// @notice Guard-identical pre-flight of `issueCredited` (amount, known +
    ///         enabled GPU, full report acceptance; maxGusdSpend is the
    ///         caller's check). The hook plans against a quote that can never
    ///         diverge from execution: it VERIFIES the exact report execution
    ///         will consume.
    function quoteIssueCredited(bytes32 gpuId, uint256 amount, bytes calldata updateData)
        external
        view
        returns (uint256 base, uint256 fee, uint256 total);
}
