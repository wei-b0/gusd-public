// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {GUSD} from "../../src/GUSD.sol";
import {sgUSD} from "../../src/sgUSD.sol";
import {ISgUSD} from "../../src/interfaces/ISgUSD.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice The sgUSD perp-underwriting extension: engine authorization, the
///         perpReserved floor on ordinary redemptions, perpWithdraw's partial
///         payment + per-block cap, and honest ERC4626 previews.
contract SGUSDPerpTest is Test {
    MockERC20 internal underlying;
    GUSD internal gusd;
    sgUSD internal sg;
    address internal alice = makeAddr("alice");
    address internal engine = makeAddr("perpEngine");

    function setUp() public {
        underlying = new MockERC20("USD Coin", "USDC", 6);
        gusd = new GUSD(IERC20(address(underlying)), address(this));
        sg = new sgUSD(IERC20(address(gusd)), address(this));
        gusd.setRevenueSink(address(sg));
        sg.setPerpEngine(engine);
        sg.setEngineMaxWithdrawPerBlock(type(uint256).max); // uncapped unless a test sets it
        _mintGusd(alice, 50_000e6);
        _mintGusd(address(this), 2_000_000e6);
        gusd.approve(address(sg), type(uint256).max);
        sg.seed(1_000_000e6); // LP seed: the vault holds 1M gUSD
    }

    function _mintGusd(address to, uint256 amt) internal {
        underlying.mint(to, amt);
        vm.startPrank(to);
        underlying.approve(address(gusd), type(uint256).max);
        gusd.mint(amt, to);
        vm.stopPrank();
    }

    function _depositAs(address who, uint256 amt) internal {
        vm.startPrank(who);
        gusd.approve(address(sg), type(uint256).max);
        sg.deposit(amt, who);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ auth

    function test_engineSetAndAuth() public {
        assertEq(sg.perpEngine(), engine);
        vm.expectRevert(ISgUSD.NotPerpEngine.selector);
        sg.setPerpReserved(1);
        vm.expectRevert(ISgUSD.NotPerpEngine.selector);
        sg.perpWithdraw(alice, 1);
        vm.prank(engine);
        sg.setPerpReserved(5);
        assertEq(sg.perpReserved(), 5);
    }

    function test_engineCannotBeZero() public {
        vm.expectRevert(sgUSD.ZeroEngine.selector);
        sg.setPerpEngine(address(0));
    }

    function test_onlyOwnerSetsEngine() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        sg.setPerpEngine(engine);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        sg.setEngineMaxWithdrawPerBlock(1);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ reservation

    function test_reservationBlocksRedemptions() public {
        // Reserve 800k of the 1M vault; only 200k is redeemable. (The seed
        // shares are locked to the vault itself — a redeemer must hold real
        // shares, so the test contract deposits.)
        vm.prank(engine);
        sg.setPerpReserved(800_000e6);
        assertEq(sg.availableForRedemption(), 200_000e6);

        _depositAs(address(this), 400_000e6); // vault 1.4M; available 600k
        assertEq(sg.maxWithdraw(address(this)), 400_000e6); // shares cap, not the floor

        // Tighten the reserve so the FLOOR binds below the share value.
        vm.prank(engine);
        sg.setPerpReserved(1_200_000e6);
        assertEq(sg.maxWithdraw(address(this)), 200_000e6);

        // Withdraw at the floor is fine.
        sg.withdraw(200_000e6, alice, address(this));
        assertEq(sg.availableForRedemption(), 0);

        // One wei over the floor reverts — the honest maxRedeem guard fires
        // first (PerpReservationShortfall stays as direct _withdraw defense).
        vm.expectRevert(
            abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxRedeem.selector, address(this), 1, 0)
        );
        sg.redeem(1, address(this), address(this));
        assertEq(sg.maxWithdraw(address(this)), 0);
        vm.expectRevert(abi.encodeWithSelector(ISgUSD.PerpReservationShortfall.selector, 0, 1));
        sg.previewWithdraw(1);
        assertEq(sg.previewRedeem(0), 0);
    }

    function test_reservationFloorClampsAtZero() public {
        // Reserved more than the vault holds: available clamps at 0, and the
        // engine can still drain what IS there.
        vm.prank(engine);
        sg.setPerpReserved(2_000_000e6);
        assertEq(sg.availableForRedemption(), 0);
        vm.prank(engine);
        uint256 paid = sg.perpWithdraw(alice, 2_000_000e6);
        assertEq(paid, 1_000_000e6); // partial: what the vault actually holds
        assertEq(gusd.balanceOf(alice), 50_000e6 + 1_000_000e6);
    }

    function test_reservationDoesNotBlockEngine() public {
        // The reserved party pays: engine withdrawal ignores the reserve floor.
        vm.prank(engine);
        sg.setPerpReserved(999_999e6);
        vm.prank(engine);
        uint256 paid = sg.perpWithdraw(alice, 500_000e6);
        assertEq(paid, 500_000e6);
        assertEq(gusd.balanceOf(alice), 50_000e6 + 500_000e6);
        assertEq(sg.availableForRedemption(), 0); // 1M − 500k paid − 999.999k reserved, clamped
    }

    // ------------------------------------------------------- per-block cap

    function test_withdrawalCapPerBlock() public {
        sg.setEngineMaxWithdrawPerBlock(300_000e6);
        vm.prank(engine);
        uint256 paid = sg.perpWithdraw(alice, 250_000e6);
        assertEq(paid, 250_000e6);
        // The cap clamps, never reverts: the 50_001st unit waits.
        vm.prank(engine);
        paid = sg.perpWithdraw(alice, 50_001e6);
        assertEq(paid, 50_000e6);
        assertEq(gusd.balanceOf(alice), 50_000e6 + 300_000e6);
        // Cap exhausted → pays nothing this block.
        vm.prank(engine);
        paid = sg.perpWithdraw(alice, 1);
        assertEq(paid, 0);
        // The cap resets on the next block.
        vm.roll(block.number + 1);
        vm.prank(engine);
        paid = sg.perpWithdraw(alice, 300_000e6);
        assertEq(paid, 300_000e6);
        assertEq(gusd.balanceOf(alice), 50_000e6 + 600_000e6);
    }

    function test_capZeroMeansFullStop() public {
        sg.setEngineMaxWithdrawPerBlock(0);
        vm.prank(engine);
        uint256 paid = sg.perpWithdraw(alice, 1);
        assertEq(paid, 0); // full stop: nothing pays, nothing reverts
        assertEq(gusd.balanceOf(alice), 50_000e6);
        assertEq(sg.availableForRedemption(), 1_000_000e6);
    }

    // ------------------------------------------------- ERC4626 semantics kept

    function test_ordinarySemanticsUnchanged() public {
        // Deposits stay unlocked, revenue still raises the share price.
        _depositAs(alice, 10_000e6);
        vm.prank(alice);
        gusd.transfer(address(sg), 1_000e6); // plain revenue transfer
        assertEq(sg.totalAssets(), 1_000_000e6 + 10_000e6 + 1_000e6);
        assertEq(sg.convertToAssets(10_000e6), 10_009_900_990); // 10_000e6 × 1_011_000e6 / 1_010_000e6, floored
        // Redemption below the reserve still works with the reservation in place.
        vm.prank(engine);
        sg.setPerpReserved(500_000e6);
        vm.prank(alice);
        sg.withdraw(5_000e6, alice, alice);
    }

    function test_reservePushedByEngineOnly() public {
        vm.prank(engine);
        sg.setPerpReserved(100);
        vm.prank(engine);
        sg.setPerpReserved(0);
        assertEq(sg.perpReserved(), 0);
    }
}