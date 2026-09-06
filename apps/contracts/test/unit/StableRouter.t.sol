// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {GUSD} from "../../src/GUSD.sol";
import {StableRouter} from "../../src/StableRouter.sol";

/// @notice Product-surface rig for StableRouter: identity mint/redeem (no
///         swap), swap mint/redeem through a plain {USDT, USDC} v4 pool,
///         slippage bounds, whitelist trust, and the pause chain. Deploy
///         order flips the pool's currency ordering, so the router's
///         zeroForOne math is exercised in both directions.
abstract contract StableRouterTestBase is Test, Deployers {
    MockERC20 internal underlying; // "USDC" — gUSD's reserve asset
    MockERC20 internal usdt; // a whitelisted swap-in stable
    MockERC20 internal dai; // 18-decimal — must never whitelist
    GUSD internal gusd;
    StableRouter internal router;
    PoolKey internal stableKey;
    address internal alice = makeAddr("alice"); // funder
    address internal sink = makeAddr("revenueSink");
    bool internal usdtIsC0;

    uint24 internal constant POOL_FEE = 100; // 1bp — stable-pool tier
    int24 internal constant TICK_SPACING = 1;

    /// @dev Deploying USDT first lowers its address — flips the pool's
    ///      currency ordering between the concrete suites.
    function _usdtDeployedFirst() internal view virtual returns (bool);

    function setUp() public virtual {
        vm.warp(1_000_000);
        deployFreshManagerAndRouters();
        if (_usdtDeployedFirst()) {
            usdt = new MockERC20("Tether USD", "USDT", 6);
            underlying = new MockERC20("USD Coin", "USDC", 6);
        } else {
            underlying = new MockERC20("USD Coin", "USDC", 6);
            usdt = new MockERC20("Tether USD", "USDT", 6);
        }
        dai = new MockERC20("Dai Stablecoin", "DAI", 18);
        gusd = new GUSD(IERC20(address(underlying)), address(this));
        router = new StableRouter(IPoolManager(address(manager)), gusd, address(this));

        // Production fee posture: fees on, sink set — the fee legs run.
        gusd.setRevenueSink(sink);
        gusd.setFees(20, 25);

        usdtIsC0 = address(usdt) < address(underlying);
        (Currency c0, Currency c1) = usdtIsC0
            ? (Currency.wrap(address(usdt)), Currency.wrap(address(underlying)))
            : (Currency.wrap(address(underlying)), Currency.wrap(address(usdt)));
        stableKey = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
        manager.initialize(stableKey, SQRT_PRICE_1_1);

        // Whitelist the swap-in stable (the underlying was whitelisted at
        // construction); the 18-decimal impostor must never pass.
        router.setStable(address(usdt), true);

        // LP the pool ~1:1 around tick 0 — deep enough that a 1000-unit swap
        // moves the price by a fraction of a bp.
        usdt.mint(address(this), 10_000_000e6);
        underlying.mint(address(this), 10_000_000e6);
        IERC20(address(usdt)).approve(address(modifyLiquidityRouter), type(uint256).max);
        IERC20(address(underlying)).approve(address(modifyLiquidityRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity(
            stableKey, ModifyLiquidityParams({tickLower: -120, tickUpper: 120, liquidityDelta: 1e15, salt: 0}), ""
        );

        // Fund alice with both stables; the router is her only spender.
        usdt.mint(alice, 1_000_000e6);
        underlying.mint(alice, 1_000_000e6);
        vm.startPrank(alice);
        IERC20(address(usdt)).approve(address(router), type(uint256).max);
        IERC20(address(underlying)).approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------- identity

    function test_identityMintMatchesDirectPreview() public {
        uint256 amountIn = 1000e6;
        uint256 expected = gusd.previewMint(amountIn);
        uint256 reserveBefore = gusd.reserveBalance();

        vm.prank(alice);
        uint256 got = router.mint(address(underlying), amountIn, amountIn, _deadKey(), alice);

        assertEq(got, expected, "identity mint must equal the direct preview");
        assertEq(gusd.balanceOf(alice), expected);
        // reserve == supply holds exactly: the pull covers the user's gUSD
        // plus the fee minted to the sink
        assertEq(gusd.reserveBalance(), reserveBefore + amountIn);
        assertEq(gusd.reserveBalance(), gusd.totalSupply());
        // the router holds nothing at rest
        assertEq(underlying.balanceOf(address(router)), 0);
        assertEq(gusd.balanceOf(address(router)), 0);
    }

    function test_identityRedeemMatchesDirectPreview() public {
        (uint256 rawIn, uint256 gusdBal) = _identityMint(alice, 500e6);
        uint256 expected = gusd.previewRedeem(gusdBal);
        uint256 underlyingBefore = underlying.balanceOf(alice);

        vm.startPrank(alice);
        gusd.approve(address(router), gusdBal);
        uint256 got = router.redeem(address(underlying), gusdBal, 0, _deadKey(), alice);
        vm.stopPrank();

        assertEq(got, expected, "identity redeem must equal the direct preview");
        assertEq(gusd.balanceOf(alice), 0);
        // underlyingBefore is post-mint — the mint's rawIn is already gone
        assertEq(underlying.balanceOf(alice), underlyingBefore + expected);
        assertEq(gusd.reserveBalance(), gusd.totalSupply());
        assertEq(underlying.balanceOf(address(router)), 0);
    }

    // ----------------------------------------------------------------- swap

    function test_swapMintHappyPath() public {
        uint256 amountIn = 1000e6;
        uint256 reserveBefore = gusd.reserveBalance();

        vm.prank(alice);
        uint256 got = router.mint(address(usdt), amountIn, 990e6, stableKey, alice);

        // The swap is 1:1-ish: the router minted nearly the full input's worth
        assertGt(got, 990e6, "swap mint should convert nearly the full input");
        assertApproxEqAbs(got, gusd.previewMint(amountIn), 1e6, "1bp pool: within ~1 unit of the direct mint");
        assertEq(gusd.balanceOf(alice), got);
        assertEq(gusd.reserveBalance(), gusd.totalSupply(), "reserve == supply through the swap path");
        assertGt(gusd.reserveBalance(), reserveBefore);
        // DustLeft: the router holds neither token at rest
        assertEq(usdt.balanceOf(address(router)), 0);
        assertEq(underlying.balanceOf(address(router)), 0);
    }

    function test_swapMintEmitsMintedViaSwap() public {
        uint256 amountIn = 100e6;
        vm.recordLogs();
        vm.prank(alice);
        router.mint(address(usdt), amountIn, 0, stableKey, alice);

        // The swap leg's flow emits transfers/Swap/Minted along the way —
        // pick the router's own event out of the stream and check its shape.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(router) && logs[i].topics[0] == StableRouter.MintedViaSwap.selector) {
                ++seen;
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(address(usdt)))), "stable topic");
                assertEq(logs[i].topics[2], bytes32(uint256(uint160(alice))), "to topic");
                (uint256 inSeen,,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                assertEq(inSeen, amountIn, "amountIn data");
            }
        }
        assertEq(seen, 1, "exactly one MintedViaSwap");
    }

    function test_swapMintRevertsWhenFloorUnmet() public {
        // minOut above the 1:1-ish pool price — the swap leg must revert
        vm.prank(alice);
        vm.expectRevert(StableRouter.Slippage.selector);
        router.mint(address(usdt), 1000e6, type(uint256).max, stableKey, alice);
    }

    function test_swapRedeemHappyPath() public {
        (, uint256 gusdBal) = _identityMint(alice, 500e6);
        uint256 expected = gusd.previewRedeem(gusdBal);
        uint256 usdtBefore = usdt.balanceOf(alice);

        vm.startPrank(alice);
        gusd.approve(address(router), gusdBal);
        uint256 got = router.redeem(address(usdt), gusdBal, 400e6, stableKey, alice);
        vm.stopPrank();

        assertGt(got, 400e6, "swap redeem should pay out nearly the full redeem value");
        assertApproxEqAbs(got, expected, 1e6, "1bp pool: within ~1 unit of the direct redeem");
        assertEq(usdt.balanceOf(alice), usdtBefore + got);
        // DustLeft: the router holds nothing at rest
        assertEq(usdt.balanceOf(address(router)), 0);
        assertEq(underlying.balanceOf(address(router)), 0);
        assertEq(gusd.balanceOf(address(router)), 0);
    }

    function test_swapRedeemRevertsWhenFloorUnmet() public {
        (, uint256 gusdBal) = _identityMint(alice, 500e6);
        vm.startPrank(alice);
        gusd.approve(address(router), gusdBal);
        vm.expectRevert(StableRouter.Slippage.selector);
        router.redeem(address(usdt), gusdBal, type(uint256).max, stableKey, alice);
        vm.stopPrank();
    }

    // ------------------------------------------------------ whitelist trust

    function test_unknownStableRevertsEvenWithValidPool() public {
        // dai's key is shaped right — the whitelist is the gate
        vm.expectRevert(StableRouter.UnknownStable.selector);
        router.mint(address(dai), 100e6, 0, _fakeDaiKey(), alice);
    }

    function test_setStableRejectsWrongDecimals() public {
        vm.expectRevert(StableRouter.InvalidStable.selector);
        router.setStable(address(dai), true);
    }

    function test_setStableRejectsZeroAddressAndEoa() public {
        vm.expectRevert(StableRouter.InvalidStable.selector);
        router.setStable(address(0), true);
        vm.expectRevert(StableRouter.InvalidStable.selector);
        router.setStable(alice, true); // no code
    }

    function test_setStableRejectsGusdItself() public {
        vm.expectRevert(StableRouter.InvalidStable.selector);
        router.setStable(address(gusd), true);
    }

    function test_setStableOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        router.setStable(address(usdt), false);
    }

    function test_setStableCanRemoveAndReadd() public {
        router.setStable(address(usdt), false);
        assertFalse(router.isStable(address(usdt)));
        assertEq(router.allStables().length, 1, "only the underlying remains");
        vm.expectRevert(StableRouter.UnknownStable.selector);
        router.mint(address(usdt), 1e6, 0, stableKey, alice);
        router.setStable(address(usdt), true);
        assertTrue(router.isStable(address(usdt)));
    }

    // ------------------------------------------------------------- pool gate

    function test_hookBearingPoolReverts() public {
        PoolKey memory hooked = stableKey;
        hooked.hooks = IHooks(address(manager)); // nonzero = rejected outright
        vm.expectRevert(StableRouter.BadPool.selector);
        router.mint(address(usdt), 100e6, 0, hooked, alice);
    }

    function test_wrongCurrencyPairReverts() public {
        PoolKey memory wrong = stableKey;
        wrong.currency1 = Currency.wrap(address(dai));
        vm.expectRevert(StableRouter.BadPool.selector);
        router.mint(address(usdt), 100e6, 0, wrong, alice);
    }

    // ---------------------------------------------------------------- pauses

    function test_routerPauseBlocksMintAndRedeem() public {
        // seed a gUSD balance so the redeem leg has something to pull
        (, uint256 gusdBal) = _identityMint(alice, 100e6);
        router.pause();
        vm.startPrank(alice);
        vm.expectRevert();
        router.mint(address(usdt), 100e6, 0, stableKey, alice);
        vm.expectRevert();
        router.redeem(address(underlying), gusdBal, 0, _deadKey(), alice);
        vm.stopPrank();
        router.unpause();
        // works again after unpause
        vm.startPrank(alice);
        router.mint(address(usdt), 100e6, 0, stableKey, alice);
        gusd.approve(address(router), gusdBal);
        router.redeem(address(underlying), gusdBal, 0, _deadKey(), alice);
        vm.stopPrank();
    }

    function test_gusdPausedFailsBeforeAnySwapOrPull() public {
        gusd.pause();
        uint256 aliceUsdtBefore = usdt.balanceOf(alice);
        uint256 aliceUnderlyingBefore = underlying.balanceOf(alice);
        vm.expectRevert(StableRouter.GUSDPaused.selector);
        router.mint(address(usdt), 100e6, 0, stableKey, alice);
        vm.expectRevert(StableRouter.GUSDPaused.selector);
        router.mint(address(underlying), 100e6, 100e6, _deadKey(), alice);
        // nothing was pulled — the cheap check precedes every transfer
        assertEq(usdt.balanceOf(alice), aliceUsdtBefore);
        assertEq(underlying.balanceOf(alice), aliceUnderlyingBefore);
        gusd.unpause();
    }

    function test_zeroAmountReverts() public {
        vm.expectRevert(StableRouter.ZeroAmount.selector);
        router.mint(address(usdt), 0, 0, stableKey, alice);
        vm.expectRevert(StableRouter.ZeroAmount.selector);
        router.redeem(address(usdt), 0, 0, stableKey, alice);
    }

    // -------------------------------------------------------------- helpers

    /// @dev Mints gUSD to `to` through the router's identity path (reserve in,
    ///      no swap). Returns the underlying consumed and the gUSD received.
    function _identityMint(address to, uint256 amountIn) internal returns (uint256 rawIn, uint256 gusdOut) {
        rawIn = amountIn;
        vm.prank(to);
        gusdOut = router.mint(address(underlying), rawIn, rawIn, _deadKey(), to);
    }

    /// @dev Placeholder key for identity paths — validation never runs there.
    function _deadKey() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(1)),
            fee: 100,
            tickSpacing: 1,
            hooks: IHooks(address(0))
        });
    }

    function _fakeDaiKey() internal view returns (PoolKey memory) {
        (Currency c0, Currency c1) = address(dai) < address(underlying)
            ? (Currency.wrap(address(dai)), Currency.wrap(address(underlying)))
            : (Currency.wrap(address(underlying)), Currency.wrap(address(dai)));
        return PoolKey({currency0: c0, currency1: c1, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: IHooks(address(0))});
    }
}

contract StableRouterTest_UsdtIsC0 is StableRouterTestBase {
    function _usdtDeployedFirst() internal view virtual override returns (bool) {
        return true;
    }
}

contract StableRouterTest_UsdtIsC1 is StableRouterTestBase {
    function _usdtDeployedFirst() internal view virtual override returns (bool) {
        return false;
    }
}
