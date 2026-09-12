// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {RevenueLedger} from "../../src/RevenueLedger.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract RevenueLedgerTest is Test {
    MockERC20 internal gusd;
    RevenueLedger internal ledger;
    address internal vault = makeAddr("vault");
    address internal treasury = makeAddr("treasury");
    address internal rando = makeAddr("rando");

    function setUp() public {
        gusd = new MockERC20("gUSD", "gUSD", 6);
        ledger = new RevenueLedger(IERC20(address(gusd)), address(this));
        ledger.setVault(vault);
        ledger.setTreasury(treasury);
    }

    function test_splitEvenly() public {
        gusd.mint(address(ledger), 1_000e6);
        ledger.distribute();
        assertEq(gusd.balanceOf(vault), 500e6);
        assertEq(gusd.balanceOf(treasury), 500e6);
        assertEq(ledger.totalToVault(), 500e6);
        assertEq(ledger.totalToTreasury(), 500e6);
    }

    function test_floorSplitNoDustLost() public {
        ledger.setSplit(3_333);
        gusd.mint(address(ledger), 10_001);
        ledger.distribute(); // floor(10001*3333/1e4) = 3333, remainder 6668
        assertEq(gusd.balanceOf(vault), 3_333);
        assertEq(gusd.balanceOf(treasury), 6_668);
        assertEq(ledger.totalToVault() + ledger.totalToTreasury(), 10_001);
    }

    function test_zeroAndFullSplits() public {
        ledger.setSplit(0);
        gusd.mint(address(ledger), 100);
        ledger.distribute();
        assertEq(gusd.balanceOf(vault), 0);
        assertEq(gusd.balanceOf(treasury), 100);

        gusd.mint(address(ledger), 50);
        ledger.setSplit(10_000);
        ledger.distribute();
        assertEq(gusd.balanceOf(vault), 50);
    }

    function test_conservationAcrossRepeatedDistributes() public {
        uint256 totalIn;
        for (uint256 i = 1; i <= 5; ++i) {
            gusd.mint(address(ledger), i * 111_111);
            totalIn += i * 111_111;
        }
        ledger.distribute();
        vm.expectRevert(RevenueLedger.NothingToDistribute.selector);
        ledger.distribute(); // empty now
        assertEq(ledger.totalToVault() + ledger.totalToTreasury(), totalIn);
    }

    function test_secondDistributeRevertsWhenEmpty() public {
        gusd.mint(address(ledger), 100);
        ledger.distribute();
        vm.expectRevert(RevenueLedger.NothingToDistribute.selector);
        ledger.distribute();
    }

    function test_permissionlessDistribution() public {
        gusd.mint(address(ledger), 400);
        vm.prank(rando);
        ledger.distribute();
        assertEq(gusd.balanceOf(vault), 200);
    }

    function test_onlyOwnerSetsConfig() public {
        vm.startPrank(rando);
        vm.expectRevert();
        ledger.setSplit(1);
        vm.expectRevert();
        ledger.setVault(rando);
        vm.expectRevert();
        ledger.setTreasury(rando);
        vm.stopPrank();
        vm.expectRevert(RevenueLedger.SplitTooLarge.selector);
        ledger.setSplit(10_001);
    }

    function test_zeroAddressRecipientsRevert() public {
        vm.expectRevert(RevenueLedger.ZeroAddress.selector);
        ledger.setVault(address(0));
        vm.expectRevert(RevenueLedger.ZeroAddress.selector);
        ledger.setTreasury(address(0));
    }

    function test_pendingRevenue() public {
        assertEq(ledger.pendingRevenue(), 0);
        gusd.mint(address(ledger), 700);
        assertEq(ledger.pendingRevenue(), 700);
    }

    // --------------------------------------------------------------- sweep

    /// Non-gUSD inflows move out in full, owner-gated; gUSD itself stays
    /// reserved for distribute()'s split.
    function test_sweepMovesFullBalance() public {
        MockERC20 stray = new MockERC20("stray", "STRAY", 18);
        stray.mint(address(ledger), 123);
        vm.expectEmit(true, true, false, true);
        emit RevenueLedger.Swept(address(stray), treasury, 123);
        ledger.sweep(address(stray), treasury);
        assertEq(stray.balanceOf(treasury), 123);
        assertEq(stray.balanceOf(address(ledger)), 0);
    }

    function test_sweepIsIdempotentOnZero() public {
        MockERC20 stray = new MockERC20("stray", "STRAY", 18);
        ledger.sweep(address(stray), treasury); // no balance: silent no-op
        ledger.sweep(address(stray), treasury);
        assertEq(stray.balanceOf(treasury), 0);
    }

    function test_sweepSweepsWhateverIsThere() public {
        MockERC20 stray = new MockERC20("stray", "STRAY", 18);
        stray.mint(address(ledger), 50);
        ledger.sweep(address(stray), rando);
        stray.mint(address(ledger), 77);
        ledger.sweep(address(stray), rando); // full balance again
        assertEq(stray.balanceOf(rando), 127);
    }

    function test_sweepGusdReverts() public {
        gusd.mint(address(ledger), 100);
        vm.expectRevert(RevenueLedger.SweptTokenIsGusd.selector);
        ledger.sweep(address(gusd), treasury);
        assertEq(gusd.balanceOf(address(ledger)), 100); // untouched
        assertEq(ledger.pendingRevenue(), 100);
    }

    function test_sweepZeroAddressReverts() public {
        MockERC20 stray = new MockERC20("stray", "STRAY", 18);
        stray.mint(address(ledger), 1);
        vm.expectRevert(RevenueLedger.ZeroAddress.selector);
        ledger.sweep(address(stray), address(0));
    }

    function test_sweepOnlyOwner() public {
        MockERC20 stray = new MockERC20("stray", "STRAY", 18);
        stray.mint(address(ledger), 1);
        vm.prank(rando);
        vm.expectRevert(); // OwnableUnauthorizedAccount — onlyOwner gates every sweep
        ledger.sweep(address(stray), rando);
        assertEq(stray.balanceOf(rando), 0);
    }
}
