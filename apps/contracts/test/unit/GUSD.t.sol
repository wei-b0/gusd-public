// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {GUSD} from "../../src/GUSD.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract GUSDTest is Test {
    MockERC20 internal usdc;
    GUSD internal gusd;
    address internal sink = makeAddr("sink");
    address internal alice = makeAddr("alice");

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        gusd = new GUSD(IERC20(address(usdc)), address(this));
        usdc.mint(alice, 1_000_000e6);
        usdc.mint(address(this), 1_000_000e6);
    }

    function _approve(address who, uint256 amt) internal {
        vm.prank(who);
        usdc.approve(address(gusd), type(uint256).max);
    }

    function _mintThrough(address who, uint256 amt) internal returns (uint256) {
        _approve(who, amt);
        vm.prank(who);
        return gusd.mintUSDC(amt, who);
    }

    function test_feelessMintIsOneToOne() public {
        uint256 out = _mintThrough(alice, 10_000e6);
        assertEq(out, 10_000e6);
        assertEq(gusd.balanceOf(alice), 10_000e6);
        assertEq(gusd.reserveBalance(), 10_000e6);
        assertEq(gusd.reserveBalance(), gusd.totalSupply());
    }

    function test_feelessRedeemIsOneToOne() public {
        uint256 out = _mintThrough(alice, 10_000e6);
        vm.prank(alice);
        uint256 got = gusd.redeemUSDC(out, alice);
        assertEq(got, 10_000e6);
        assertEq(usdc.balanceOf(alice), 1_000_000e6);
        assertEq(gusd.totalSupply(), 0);
        assertEq(gusd.reserveBalance(), 0);
    }

    function test_feeCeilRoundingFavorsProtocol() public {
        gusd.setRevenueSink(sink);
        gusd.setFees(33, 0); // 0.33%
        uint256 out = _mintThrough(alice, 100_003); // fee = ceil(100003*33/1e4) = 331
        assertEq(out, 100_003 - 331);
        assertEq(gusd.balanceOf(sink), 331);
        assertEq(gusd.reserveBalance(), gusd.totalSupply());
    }

    function test_zeroNetAmountReverts() public {
        gusd.setRevenueSink(sink);
        gusd.setFees(500, 0); // max 5%
        _approve(alice, 10);
        vm.prank(alice);
        vm.expectRevert(GUSD.ZeroNetAmount.selector);
        gusd.mintUSDC(1, alice); // fee = ceil(1*500/1e4) = 1 -> out 0
    }

    function test_feeAboveCapReverts() public {
        gusd.setRevenueSink(sink);
        vm.expectRevert(GUSD.FeeTooLarge.selector);
        gusd.setFees(501, 0);
    }

    function test_pauseBlocksMintRedeemNotTransfer() public {
        uint256 out = _mintThrough(alice, 5_000e6);
        gusd.pause();
        vm.prank(alice);
        vm.expectRevert();
        gusd.mintUSDC(1, alice);
        vm.prank(alice);
        gusd.transfer(address(this), 1e6); // transfers stay live
        gusd.unpause();
        vm.prank(alice);
        gusd.redeemUSDC(1e6, alice);
        assertEq(usdc.balanceOf(alice), 1_000_000e6 - 5_000e6 + 1e6);
    }

    function test_reserveEqualsSupplyAfterOps() public {
        gusd.setRevenueSink(sink);
        gusd.setFees(100, 100);
        for (uint256 i; i < 5; ++i) {
            uint256 amt = 1_000_001 + i * 7; // indivisible by 1e4 bias
            uint256 m = _mintThrough(alice, amt);
            assertEq(gusd.reserveBalance(), gusd.totalSupply());
            assertGe(gusd.balanceOf(alice) + gusd.balanceOf(sink), m);
        }
        vm.startPrank(alice);
        gusd.redeemUSDC(gusd.balanceOf(alice) / 2, alice);
        assertEq(gusd.reserveBalance(), gusd.totalSupply());
        gusd.redeemUSDC(gusd.balanceOf(alice), alice);
        vm.stopPrank();
        assertEq(gusd.reserveBalance(), gusd.totalSupply());
    }
}
