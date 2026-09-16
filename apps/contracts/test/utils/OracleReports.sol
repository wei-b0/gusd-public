// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {GpuOracle} from "../../src/oracle/GpuOracle.sol";
import {IGpuOracle} from "../../src/oracle/IGpuOracle.sol";
import {ReportCodec} from "../../src/oracle/ReportCodec.sol";

/// @dev Shared report-signing rig for every suite that prices against the
///      pull oracle. Deploys a real GpuOracle with a test attestor key and
///      provides EIP-712 report construction/signing in the wire format
///      (`updateData = abi.encode(Report, signature)`).
abstract contract OracleReports is Test {
    GpuOracle internal oracle;
    uint256 internal constant SIGNER_PK = 0xA11CE;
    address internal signer;

    uint64 internal constant EPOCH_LENGTH = 60;
    uint64 internal constant MAX_AGE = 300;

    bytes32 internal constant H100 = bytes32(bytes("H100_SXM_80GB"));
    bytes32 internal constant H200 = bytes32(bytes("H200_141GB"));

    function _deployOracle() internal {
        vm.warp(1_000_000);
        signer = vm.addr(SIGNER_PK);
        oracle = new GpuOracle(address(this), signer, EPOCH_LENGTH, MAX_AGE);
    }

    /// @dev A report for the CURRENT epoch, observed 5s ago — the healthy
    ///      default every happy-path test signs.
    function _report(bytes32 gpuId, uint256 price) internal view returns (IGpuOracle.Report memory r) {
        r = _reportAt(gpuId, price, uint64(block.timestamp - 5));
    }

    /// @dev Full control: epoch is derived from the chain clock, observation
    ///      timestamp supplied (staleness/future tests move it).
    function _reportAt(bytes32 gpuId, uint256 price, uint64 observedAt)
        internal
        view
        returns (IGpuOracle.Report memory r)
    {
        uint64 epoch = uint64(block.timestamp / EPOCH_LENGTH);
        r = IGpuOracle.Report({
            version: 1,
            gpuId: gpuId,
            price: price,
            observedAt: observedAt,
            epoch: epoch,
            validFrom: epoch * EPOCH_LENGTH,
            validUntil: (epoch + 1) * EPOCH_LENGTH,
            calcHash: bytes32(uint256(0xC0DEC0DE))
        });
    }

    function _sign(IGpuOracle.Report memory r) internal view returns (bytes memory) {
        (uint8 v, bytes32 r32, bytes32 s) = vm.sign(SIGNER_PK, oracle.reportDigest(r));
        return abi.encodePacked(r32, s, v);
    }

    /// @dev Wire format the callers submit: `abi.encode(Report, signature)`.
    function _updateData(bytes32 gpuId, uint256 price) internal view returns (bytes memory) {
        IGpuOracle.Report memory r = _report(gpuId, price);
        return abi.encode(r, _sign(r));
    }

    function _updateDataFor(IGpuOracle.Report memory r) internal view returns (bytes memory) {
        return abi.encode(r, _sign(r));
    }

    /// @dev Advance into the next epoch — every per-epoch binding resets.
    function _nextEpoch() internal {
        vm.warp((block.timestamp / EPOCH_LENGTH + 1) * EPOCH_LENGTH);
    }
}
