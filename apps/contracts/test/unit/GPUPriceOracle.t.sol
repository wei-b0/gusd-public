// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {GPUPriceOracle} from "../../src/oracle/GPUPriceOracle.sol";
import {GpuId} from "../../src/libraries/GpuId.sol";

contract GPUPriceOracleTest is Test {
    GPUPriceOracle internal oracle;
    address internal publisher = makeAddr("publisher");
    address internal alice = makeAddr("alice");

    bytes32 internal constant H100 = bytes32(bytes("H100_SXM_80GB"));
    bytes32 internal constant H200 = bytes32(bytes("H200_141GB"));

    function setUp() public {
        vm.warp(1_000_000);
        // deploy default: deviation bound disabled (0), publisher = publisher EOA
        oracle = new GPUPriceOracle(address(this), publisher, 0);
    }

    // ------------------------------------------------------------- constructor

    function test_constructor_zeroPublisherReverts() public {
        vm.expectRevert(GPUPriceOracle.ZeroPublisher.selector);
        new GPUPriceOracle(address(this), address(0), 0);
    }

    // ------------------------------------------------------------ publish auth

    function test_publisherCanPublish() public {
        vm.expectEmit(address(oracle));
        emit GPUPriceOracle.PricePublished(H100, 25_000, block.timestamp, 0);
        vm.prank(publisher);
        oracle.publish(H100, 25_000, block.timestamp);
        (uint256 price, uint256 updatedAt) = oracle.getPrice(H100);
        assertEq(price, 25_000);
        assertEq(updatedAt, block.timestamp);
    }

    function test_randomAddressCannotPublish() public {
        vm.prank(alice);
        vm.expectRevert(GPUPriceOracle.NotPublisher.selector);
        oracle.publish(H100, 25_000, block.timestamp);
    }

    function test_ownerCannotPublish_hatchIsSeparate() public {
        // the owner writes only through setPriceOverride; publish() is publisher-only
        vm.expectRevert(GPUPriceOracle.NotPublisher.selector);
        oracle.publish(H100, 25_000, block.timestamp);
    }

    function test_zeroPriceReverts() public {
        vm.prank(publisher);
        vm.expectRevert(GPUPriceOracle.InvalidPrice.selector);
        oracle.publish(H100, 0, block.timestamp);
    }

    function test_invalidGpuIdReverts() public {
        // empty
        vm.prank(publisher);
        vm.expectRevert(GpuId.EmptyGpuId.selector);
        oracle.publish(bytes32(0), 25_000, block.timestamp);
        // non-printable byte (0x20 space is below the 0x21 floor)
        bytes32 spaced = bytes32(bytes("H100 SXM_80GB"));
        vm.prank(publisher);
        vm.expectRevert(GpuId.InvalidGpuIdChar.selector);
        oracle.publish(spaced, 25_000, block.timestamp);
        // data after an embedded zero (not left-aligned padding)
        bytes32 misaligned = bytes32(abi.encodePacked(bytes3("H10"), bytes1(0), bytes1("0")));
        vm.prank(publisher);
        vm.expectRevert(GpuId.GpuIdNotLeftAligned.selector);
        oracle.publish(misaligned, 25_000, block.timestamp);
    }

    // -------------------------------------------------------------- timestamps

    function test_timestampStoredAsIs() public {
        vm.prank(publisher);
        oracle.publish(H100, 25_000, block.timestamp - 30);
        (, uint256 updatedAt) = oracle.getPrice(H100);
        assertEq(updatedAt, block.timestamp - 30);
    }

    function test_futureTimestampClamped() public {
        // a publisher clock that ran ahead of the chain clock must not store a
        // future updatedAt (GPUIssuance reverts OracleFutureTimestamp on it)
        vm.expectEmit(address(oracle));
        emit GPUPriceOracle.PricePublished(H100, 25_000, block.timestamp, 0);
        vm.prank(publisher);
        oracle.publish(H100, 25_000, block.timestamp + 5);
        (, uint256 updatedAt) = oracle.getPrice(H100);
        assertEq(updatedAt, block.timestamp);
    }

    // --------------------------------------------------------- deviation bound

    function test_firstPublishBypassesDeviation() public {
        oracle.setMaxDeviationBps(2000); // 20%
        vm.prank(publisher);
        oracle.publish(H200, 1_000_000, block.timestamp); // no previous price
        (uint256 price,) = oracle.getPrice(H200);
        assertEq(price, 1_000_000);
    }

    function test_deviationExactlyAtBoundPasses() public {
        oracle.setMaxDeviationBps(2000); // 20%
        vm.startPrank(publisher);
        oracle.publish(H100, 25_000, block.timestamp);
        // +20.000%: scaled delta = 5000*10_000/25_000 = 2000 == bound -> passes
        oracle.publish(H100, 30_000, block.timestamp);
        vm.stopPrank();
        (uint256 price,) = oracle.getPrice(H100);
        assertEq(price, 30_000);
    }

    function test_deviationAboveBoundReverts_stateUnchanged() public {
        oracle.setMaxDeviationBps(2000);
        vm.startPrank(publisher);
        oracle.publish(H100, 25_000, block.timestamp);
        // +20.012%: floor(5003*10_000/25_000) = 2001 > 2000 -> reverts
        vm.expectRevert(abi.encodeWithSelector(GPUPriceOracle.DeviationExceeded.selector, 25_000, 30_003, 2000));
        oracle.publish(H100, 30_003, block.timestamp);
        vm.stopPrank();
        (uint256 price, uint256 updatedAt) = oracle.getPrice(H100);
        assertEq(price, 25_000, "reverted publish must not move the price");
        assertEq(updatedAt, block.timestamp);
    }

    function test_deviationDownwardSymmetric() public {
        oracle.setMaxDeviationBps(2000);
        vm.startPrank(publisher);
        oracle.publish(H100, 25_000, block.timestamp);
        oracle.publish(H100, 30_000, block.timestamp);
        // -20.013% from 30_000: floor(6004*10_000/30_000) = 2001 -> reverts
        vm.expectRevert(abi.encodeWithSelector(GPUPriceOracle.DeviationExceeded.selector, 30_000, 23_996, 2000));
        oracle.publish(H100, 23_996, block.timestamp);
        // exactly -20%: scaled delta = 2000 -> passes
        oracle.publish(H100, 24_000, block.timestamp);
        vm.stopPrank();
        (uint256 price,) = oracle.getPrice(H100);
        assertEq(price, 24_000);
    }

    function test_deviationDisabledWhenZero() public {
        // setUp deploys with bound 0: a 4x jump publishes freely
        vm.startPrank(publisher);
        oracle.publish(H100, 25_000, block.timestamp);
        oracle.publish(H100, 100_000, block.timestamp);
        vm.stopPrank();
        (uint256 price,) = oracle.getPrice(H100);
        assertEq(price, 100_000);
    }

    function test_ownerCanRaiseBound() public {
        oracle.setMaxDeviationBps(2000);
        vm.prank(publisher);
        oracle.publish(H100, 25_000, block.timestamp);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(GPUPriceOracle.DeviationExceeded.selector, 25_000, 30_003, 2000));
        oracle.publish(H100, 30_003, block.timestamp);
        oracle.setMaxDeviationBps(3000); // owner raises to 30%
        vm.prank(publisher);
        oracle.publish(H100, 30_003, block.timestamp); // floor 2001 <= 3000 -> passes
        (uint256 price,) = oracle.getPrice(H100);
        assertEq(price, 30_003);
    }

    function test_setMaxDeviationBps_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        oracle.setMaxDeviationBps(100);
    }

    function test_setMaxDeviationBps_event() public {
        vm.expectEmit(address(oracle));
        emit GPUPriceOracle.MaxDeviationBpsSet(500);
        oracle.setMaxDeviationBps(500);
        assertEq(oracle.maxDeviationBps(), 500);
    }

    // --------------------------------------------------------- override hatch

    function test_override_ownerOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        oracle.setPriceOverride(H100, 25_000, block.timestamp);
    }

    function test_override_bypassesDeviationAndMovesBaseline() public {
        oracle.setMaxDeviationBps(2000);
        vm.prank(publisher);
        oracle.publish(H100, 25_000, block.timestamp);
        // a 2.4x jump via the hatch: incident response crosses any gap
        vm.expectEmit(address(oracle));
        emit GPUPriceOracle.PriceOverridden(H100, 60_000, block.timestamp);
        oracle.setPriceOverride(H100, 60_000, block.timestamp);
        (uint256 price,) = oracle.getPrice(H100);
        assertEq(price, 60_000);
        // the publisher continues from the new baseline: +20% of 60_000 is in bounds
        vm.prank(publisher);
        oracle.publish(H100, 72_000, block.timestamp);
        (price,) = oracle.getPrice(H100);
        assertEq(price, 72_000);
    }

    function test_override_clampsFutureTimestamp() public {
        oracle.setPriceOverride(H100, 25_000, block.timestamp + 5);
        (, uint256 updatedAt) = oracle.getPrice(H100);
        assertEq(updatedAt, block.timestamp);
    }

    // ------------------------------------------------------------- rotation

    function test_rotationLifecycle() public {
        address next = makeAddr("nextPublisher");
        vm.expectEmit(address(oracle));
        emit GPUPriceOracle.PublisherTransferStarted(publisher, next);
        oracle.transferPublisher(next);

        vm.prank(alice);
        vm.expectRevert(GPUPriceOracle.NotPendingPublisher.selector);
        oracle.acceptPublisher();

        vm.expectEmit(address(oracle));
        emit GPUPriceOracle.PublisherAccepted(publisher, next);
        vm.prank(next);
        oracle.acceptPublisher();

        // old publisher is now unauthorized; the new one can publish
        vm.prank(publisher);
        vm.expectRevert(GPUPriceOracle.NotPublisher.selector);
        oracle.publish(H100, 25_000, block.timestamp);
        vm.prank(next);
        oracle.publish(H100, 25_000, block.timestamp);

        // pending is cleared: a second accept reverts
        vm.prank(next);
        vm.expectRevert(GPUPriceOracle.NotPendingPublisher.selector);
        oracle.acceptPublisher();
    }

    function test_transferPublisher_zeroReverts() public {
        vm.expectRevert(GPUPriceOracle.ZeroPublisher.selector);
        oracle.transferPublisher(address(0));
    }

    function test_transferPublisher_ownerOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        oracle.transferPublisher(alice);
    }

    // ------------------------------------------------------------ conformance

    function test_priceScaleConformance() public {
        assertEq(oracle.PRICE_SCALE(), 10_000);
        assertEq(GPUPriceOracle(address(oracle)).PRICE_SCALE(), 10_000);
    }

    function test_unknownGpuReturnsZeroZero() public {
        (uint256 price, uint256 updatedAt) = oracle.getPrice(H200);
        assertEq(price, 0);
        assertEq(updatedAt, 0);
    }
}
