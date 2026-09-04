// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IGPUPriceOracle — the minimal surface the protocol consumes.
/// @notice COORDINATION CONTRACT with the offchain oracle stack:
///         - `price` is USD per GPU-hour in 4-decimal fixed point
///           (real price × PRICE_SCALE = 10_000; matches the TS
///           `numeric(12,4)` / round4 convention in packages/db).
///         - `gpuId` is the canonical bytes32 GPU identifier (see
///           src/libraries/GpuId.sol): left-aligned ASCII of the SKU string.
///         - `updatedAt` is unix seconds of the last observation.
interface IGPUPriceOracle {
    function PRICE_SCALE() external view returns (uint256);

    /// @return price USD-per-GPU-hour × 10_000 (0 = unknown)
    /// @return updatedAt unix seconds of the last observation
    function getPrice(bytes32 gpuId) external view returns (uint256 price, uint256 updatedAt);
}
