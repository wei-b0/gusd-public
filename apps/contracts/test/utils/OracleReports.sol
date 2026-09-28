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

    // EIP-712 domain/typehash duplicated from GpuOracle (OZ EIP712, name
    // "gUSD GPU Oracle", version "1") so `_sign` never makes an external
    // call: a `reportDigest` staticcall while building call arguments would
    // consume `vm.prank`/`vm.expectRevert` armed for the call under test
    // (e.g. `vm.prank(alice); issuance.issue(..., _updateData(...))` would
    // execute `issue` as the test contract). Keep in sync with GpuOracle.
    bytes32 private constant _REPORT_TYPEHASH = keccak256(
        "Report(uint16 version,bytes32 gpuId,uint256 price,uint64 observedAt,uint64 epoch,uint64 validFrom,uint64 validUntil,bytes32 calcHash)"
    );
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function _digest(IGpuOracle.Report memory r) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                _DOMAIN_TYPEHASH,
                keccak256(bytes("gUSD GPU Oracle")),
                keccak256(bytes("1")),
                block.chainid,
                address(oracle)
            )
        );
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                domain,
                keccak256(
                    abi.encode(
                        _REPORT_TYPEHASH,
                        r.version,
                        r.gpuId,
                        r.price,
                        r.observedAt,
                        r.epoch,
                        r.validFrom,
                        r.validUntil,
                        r.calcHash
                    )
                )
            )
        );
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
        (uint8 v, bytes32 r32, bytes32 s) = vm.sign(SIGNER_PK, _digest(r));
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
