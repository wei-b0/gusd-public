// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Narrow surface for revenue payers (GPUHook harvest target).
interface IRevenueLedger {
    function distribute() external;
    function pendingRevenue() external view returns (uint256);
}
