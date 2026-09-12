// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {GpuId} from "../../src/libraries/GpuId.sol";

/// @notice Unit tests for the canonical GPU-ID encoding (packages/gpu-catalog parity).
contract GpuIdTest is Test {
    bytes32 internal constant H100 = bytes32(bytes("H100_SXM_80GB"));
    bytes32 internal constant H200 = bytes32(bytes("H200_141GB"));
    bytes32 internal constant L40S = bytes32(bytes("L40S_48GB"));
    bytes32 internal constant RTX_4090 = bytes32(bytes("RTX_4090_24GB"));

    function test_roundTripsLaunchCatalogue() public pure {
        assertEq(GpuId.fromString("H100_SXM_80GB"), H100);
        assertEq(GpuId.fromString("H200_141GB"), H200);
        assertEq(GpuId.fromString("L40S_48GB"), L40S);
        assertEq(GpuId.fromString("RTX_4090_24GB"), RTX_4090);
    }
}

/// @dev External boundary so vm.expectRevert observes library reverts reliably.
contract GpuIdCaller {
    function encode(string memory sku) external pure returns (bytes32) {
        return GpuId.fromString(sku);
    }

    function check(bytes32 gpuId) external pure {
        GpuId.validate(gpuId);
    }
}

contract GpuIdRevertTest is Test {
    GpuIdCaller internal caller;

    function setUp() public {
        caller = new GpuIdCaller();
    }

    function test_rejectsEmpty() public {
        vm.expectRevert(GpuId.EmptyGpuId.selector);
        caller.encode("");
    }

    function test_rejectsTooLong() public {
        vm.expectRevert(GpuId.GpuIdTooLong.selector);
        caller.encode("A100_SXM_80GB_WITH_A_VERY_LONG_SUFFIX_XX");
    }

    function test_rejectsControlChars() public {
        vm.expectRevert(GpuId.InvalidGpuIdChar.selector);
        caller.encode("H100 X");
        vm.expectRevert(GpuId.InvalidGpuIdChar.selector);
        caller.encode("H100\x7FX");
    }

    function test_validateNotLeftAligned() public {
        bytes32 bad = bytes32(uint256(0x4831000000000000000000000000000000000000000000000000000000000041));
        vm.expectRevert(GpuId.GpuIdNotLeftAligned.selector);
        caller.check(bad);
    }

    function test_validateRejectsAllZero() public {
        vm.expectRevert(GpuId.EmptyGpuId.selector);
        caller.check(bytes32(0));
    }
}

contract GpuIdPureTest is Test {
    bytes32 internal constant H100 = bytes32(bytes("H100_SXM_80GB"));
    bytes32 internal constant H200 = bytes32(bytes("H200_141GB"));
    bytes32 internal constant L40S = bytes32(bytes("L40S_48GB"));
    bytes32 internal constant RTX_4090 = bytes32(bytes("RTX_4090_24GB"));

    function test_isValidTruthTable() public pure {
        assertTrue(GpuId.isValid(H100));
        assertTrue(GpuId.isValid(bytes32(bytes("X"))));
        assertFalse(GpuId.isValid(bytes32(0)));
        assertFalse(GpuId.isValid(bytes32(uint256(0x4100000000000000000000000000000000000000000000000000000000000080))));
    }

    function test_toStringRoundTrip() public pure {
        assertEq(GpuId.toString(H100), "H100_SXM_80GB");
        assertEq(GpuId.toString(GpuId.fromString("L40S_48GB")), "L40S_48GB");
        assertEq(GpuId.toString(H200), "H200_141GB");
        assertEq(GpuId.toString(RTX_4090), "RTX_4090_24GB");
    }
}
