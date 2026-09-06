// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {GUSD} from "../../src/GUSD.sol";
import {sgUSD} from "../../src/sgUSD.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SGUSDTest is Test {
    MockERC20 internal underlying;
    GUSD internal gusd;
    sgUSD internal sg;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        underlying = new MockERC20("USD Coin", "USDC", 6);
        gusd = new GUSD(IERC20(address(underlying)), address(this));
        sg = new sgUSD(IERC20(address(gusd)), address(this));
        gusd.setRevenueSink(address(sg)); // sink may be any gUSD holder
        underlying.mint(alice, 100_000e6);
        underlying.mint(bob, 100_000e6);
        _mintGusd(alice, 50_000e6);
        _mintGusd(bob, 20_000e6);
        underlying.mint(address(this), 10e6);
        underlying.approve(address(gusd), type(uint256).max);
        gusd.mint(1e6, address(this));
        gusd.approve(address(sg), type(uint256).max);
        sg.seed(1e6);
    }

    function _mintGusd(address to, uint256 amt) internal {
        vm.startPrank(to);
        underlying.approve(address(gusd), type(uint256).max);
        gusd.mint(amt, to);
        vm.stopPrank();
    }

    function test_preSeedDepositReverts() public {
        // fresh, unseeded vault (setUp already seeds the main one)
        sgUSD fresh = new sgUSD(IERC20(address(gusd)), address(this));
        underlying.mint(bob, 100e6);
        _mintGusd(bob, 100e6);
        vm.startPrank(bob);
        gusd.approve(address(fresh), type(uint256).max);
        vm.expectRevert(sgUSD.NotSeeded.selector);
        fresh.deposit(100e6, bob);
        vm.stopPrank();
    }

    function test_postSeedDepositIsOneToOne() public {
        vm.prank(alice);
        gusd.approve(address(sg), type(uint256).max);
        vm.prank(alice);
        uint256 sh = sg.deposit(10_000e6, alice);
        assertEq(sh, 10_000e6); // 1:1 right after seed
        assertEq(sg.convertToAssets(sh), 10_000e6);
    }

    function test_revenueRaisePerSharePrice() public {
        vm.prank(alice);
        gusd.approve(address(sg), type(uint256).max);
        vm.startPrank(alice);
        sg.deposit(10_000e6, alice);
        vm.stopPrank();
        vm.prank(bob);
        gusd.approve(address(sg), type(uint256).max);
        vm.startPrank(bob);
        sg.deposit(10_000e6, bob);
        vm.stopPrank();
        // simulate revenue: plain gUSD transfer into the vault
        vm.prank(alice);
        gusd.transfer(address(sg), 1_000e6);
        // seed 1e6 + deposits 20_000e6 + 1_000e6 revenue
        assertEq(sg.totalAssets(), 21_001_000_000);
        // alice: 10_000e6 of 20_001e6 shares -> proportional assets
        assertEq(sg.convertToAssets(10_000e6), 10_499_975_001);
    }

    function test_donationDoesNotProfitDonor() public {
        vm.prank(alice);
        gusd.approve(address(sg), type(uint256).max);
        vm.startPrank(alice);
        sg.deposit(10_000e6, alice);
        vm.stopPrank();
        // attacker donates before depositing: totalAssets rises but they
        // only get shares proportional to the (inflated) pool
        _mintGusd(bob, 5_000e6);
        vm.startPrank(bob);
        gusd.approve(address(sg), type(uint256).max);
        gusd.transfer(address(sg), 5_000e6); // donation, not deposit
        // pool: 15_001e6 assets on 10_001e6 shares (incl. 1e6 seed);
        // bob gets floor(5e9 * 10_001e6 / 15_001e6)
        uint256 sh = sg.deposit(5_000e6, bob);
        vm.stopPrank();
        assertEq(sh, 3_333_444_437);
        // bob recovers (rounded down) his deposit, no inflation profit
        assertLe(sg.convertToAssets(sh), 5_000e6);
        assertGt(sg.convertToAssets(sh), 4_999_999_000);
    }

    function test_seedTwiceReverts() public {
        vm.expectRevert(sgUSD.AlreadySeeded.selector);
        sg.seed(1e6);
    }

    function test_withdrawRoundTrip() public {
        vm.prank(alice);
        gusd.approve(address(sg), type(uint256).max);
        vm.startPrank(alice);
        sg.deposit(10_000e6, alice);
        uint256 before = gusd.balanceOf(alice);
        sg.withdraw(5_000e6, alice, alice);
        vm.stopPrank();
        assertEq(gusd.balanceOf(alice), before + 5_000e6);
    }
}
