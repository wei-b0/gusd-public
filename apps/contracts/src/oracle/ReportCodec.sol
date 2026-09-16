// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IGpuOracle} from "./IGpuOracle.sol";

/// @title ReportCodec
/// @notice Encode/decode of the pull-oracle wire format:
///         `updateData = abi.encode(IGpuOracle.Report, signature)`.
///         One `bytes` carries the report from the oracle API through the
///         router parameters into `PoolManager.swap(hookData)` and the
///         issuance backstop, byte-identical across quote, simulation and
///         execution — so quoting and execution always price the same report.
library ReportCodec {
    function encode(IGpuOracle.Report memory report, bytes memory signature) internal pure returns (bytes memory) {
        return abi.encode(report, signature);
    }

    function decode(bytes calldata updateData)
        internal
        pure
        returns (IGpuOracle.Report calldata report, bytes calldata signature)
    {
        (report, signature) = abi.decode(updateData, (IGpuOracle.Report, bytes));
    }
}
