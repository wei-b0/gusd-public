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
        // Direct calldata slicing (zero-copy). `Report` is an all-static
        // struct, so `abi.encode(Report, bytes)` lays it out INLINE starting
        // at byte 0 — no leading offset word: words 0..7 = the report fields,
        // word 8 = offset to the signature block (relative to the encoding
        // start), word 9 = signature length, then the signature bytes.
        // abi.decode cannot produce calldata, so slice instead — the report
        // stays byte-identical from hookData into oracle.consume. A malformed/
        // truncated updateData yields garbage fields or an empty signature,
        // which the oracle's acceptance checks reject (fail-closed).
        assembly ("memory-safe") {
            report := updateData.offset
            let sigBlock := add(updateData.offset, calldataload(add(updateData.offset, 0x100)))
            signature.offset := add(sigBlock, 0x20)
            signature.length := calldataload(sigBlock)
        }
    }
}
