// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";
import {WETH} from "solmate/src/tokens/WETH.sol";
import {IWETH9} from "@uniswap/v4-periphery/interfaces/external/IWETH9.sol";
import {PositionManager} from "@uniswap/v4-periphery/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/PositionDescriptor.sol";
import {V4Quoter} from "@uniswap/v4-periphery/lens/V4Quoter.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/interfaces/IV4Quoter.sol";
import {Actions} from "@uniswap/v4-periphery/libraries/Actions.sol";
import {Planner, Plan} from "v4-periphery-test/shared/Planner.sol";
import {GpuRouter, GpuRouterTestBase} from "../unit/GpuRouter.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice External-LP integration: production periphery (Permit2 -> Position
///         Manager) provisioning the canonical, hook-gated pool, plus quoter
///         parity. The hook has no liquidity permissions, so LP operations must
///         never touch the trading-fee counters, and swaps must accrue LP pool
///         fees (direction-denominated) INDEPENDENTLY of the hook fee.
abstract contract PositionManagerLpTestBase is GpuRouterTestBase, DeployPermit2 {
    using PoolIdLibrary for PoolKey;

    IAllowanceTransfer internal permit2;
    PositionManager internal lpm;
    V4Quoter internal quoter;
    WETH internal weth;

    function _wantGusdIsCurrency0() internal view virtual override returns (bool);

    function setUp() public virtual override {
        super.setUp();
        weth = new WETH();
        // precompiled canonical Permit2 bytecode at the canonical address
        // (permit2 sources pin solc 0.8.17 and are not compiled here)
        permit2 = IAllowanceTransfer(deployPermit2());
        PositionDescriptor descriptor = new PositionDescriptor(IPoolManager(address(manager)), address(weth), "ETH");
        lpm = new PositionManager(IPoolManager(address(manager)), permit2, 100_000, descriptor, IWETH9(address(weth)));
        quoter = new V4Quoter(IPoolManager(address(manager)));
    }

    // ------------------------------------------------------------- helpers

    function _poolId() internal view returns (PoolId) {
        return _canonicalKey().toId();
    }

    /// @notice Permit2 double-approval: token -> permit2, then permit2 -> PM.
    function _approvePosm(address who, address token) internal {
        vm.startPrank(who);
        IERC20(token).approve(address(permit2), type(uint256).max);
        permit2.approve(token, address(lpm), type(uint160).max, type(uint48).max);
        vm.stopPrank();
    }

    function _mintEncoded(PoolKey memory key, int24 tickLower, int24 tickUpper, uint256 liquidity, address recipient)
        internal
        pure
        returns (bytes memory)
    {
        Plan memory planner = Planner.init();
        planner.add(
            Actions.MINT_POSITION,
            abi.encode(key, tickLower, tickUpper, liquidity, type(uint128).max, type(uint128).max, recipient, "")
        );
        return planner.finalizeModifyLiquidityWithClose(key);
    }

    function _increaseEncoded(uint256 tokenId, PoolKey memory key, uint256 liquidityToAdd)
        internal
        pure
        returns (bytes memory)
    {
        Plan memory planner = Planner.init();
        planner.add(
            Actions.INCREASE_LIQUIDITY, abi.encode(tokenId, liquidityToAdd, type(uint128).max, type(uint128).max, "")
        );
        return planner.finalizeModifyLiquidityWithClose(key);
    }

    function _decreaseEncoded(uint256 tokenId, PoolKey memory key, uint256 liquidityToRemove)
        internal
        pure
        returns (bytes memory)
    {
        Plan memory planner = Planner.init();
        planner.add(Actions.DECREASE_LIQUIDITY, abi.encode(tokenId, liquidityToRemove, uint128(0), uint128(0), ""));
        return planner.finalizeModifyLiquidityWithClose(key);
    }

    /// @notice Collect = decrease 0 liquidity: takes accrued fees only.
    function _collectEncoded(uint256 tokenId, PoolKey memory key) internal pure returns (bytes memory) {
        Plan memory planner = Planner.init();
        planner.add(Actions.DECREASE_LIQUIDITY, abi.encode(tokenId, uint256(0), uint128(0), uint128(0), ""));
        return planner.finalizeModifyLiquidityWithClose(key);
    }

    /// @dev alice funds + approvals for the PM path. `_issueGpuTo` deals gUSD
    ///      absolutely, so issue FIRST, then top up gUSD.
    function _setUpLpAlice(uint256 liquidity) internal returns (uint256 tokenId) {
        _issueGpuTo(alice, 500e18);
        _dealGusd(alice, 10_000_000e6);
        _approvePosm(alice, address(gusd));
        _approvePosm(alice, address(gpu));
        tokenId = lpm.nextTokenId();
        vm.startPrank(alice);
        lpm.modifyLiquidities(_mintEncoded(_canonicalKey(), -120, 120, liquidity, alice), block.timestamp + 1);
        vm.stopPrank();
        assertEq(lpm.ownerOf(tokenId), alice);
    }

    // ---------------------------------------------------------------- tests

    function test_mint_viaPermit2_addsLiquidityAndMintsNft() public {
        PoolId pid = _poolId();
        uint256 liqBefore = stateView.getLiquidity(pid);
        uint256 expectedTokenId = lpm.nextTokenId();

        uint256 tokenId = _setUpLpAlice(1e15);

        assertEq(tokenId, expectedTokenId);
        assertEq(lpm.ownerOf(tokenId), alice);
        assertEq(lpm.getPositionLiquidity(tokenId), 1e15);
        assertGt(stateView.getLiquidity(pid), liqBefore);
    }

    function test_lpOperations_doNotTouchHookCounters() public {
        uint256 tokenId = _setUpLpAlice(1e15);
        uint256 totalBefore = hook.totalTradingFeesAccrued();
        uint256 poolBefore = hook.poolTradingFeesAccrued(_poolId());

        vm.startPrank(alice);
        lpm.modifyLiquidities(_increaseEncoded(tokenId, _canonicalKey(), 1e14), block.timestamp + 1);
        lpm.modifyLiquidities(_decreaseEncoded(tokenId, _canonicalKey(), 5e14), block.timestamp + 1);
        lpm.modifyLiquidities(_collectEncoded(tokenId, _canonicalKey()), block.timestamp + 1);
        vm.stopPrank();

        assertEq(hook.totalTradingFeesAccrued(), totalBefore, "hook fee moved on LP op");
        assertEq(hook.poolTradingFeesAccrued(_poolId()), poolBefore);
        assertEq(hook.totalTradingFeesHarvested(), 0);
    }

    function test_buy_accruesLpFeeInGusd_andHookFee_independently() public {
        uint256 tokenId = _setUpLpAlice(1e15);
        uint256 hookBefore = hook.totalTradingFeesAccrued();
        uint256 aliceGusdBefore = IERC20(address(gusd)).balanceOf(alice);
        uint256 aliceGpuBefore = IERC20(address(gpu)).balanceOf(alice);

        _dealGusd(bob, 1_000_000e6);
        vm.startPrank(bob);
        IERC20(address(gusd)).approve(address(router), type(uint256).max);
        uint256 gpuOut = router.buyExactIn(GPU_ID, 1_000e6, 0, 0, bob);
        vm.stopPrank();
        assertGt(gpuOut, 0);

        // protocol trading fee: gUSD-denominated, accrued to the hook
        assertGt(hook.totalTradingFeesAccrued(), hookBefore);

        // LP pool fee: accrued in gUSD (input currency on BUY), collectable via PM
        bytes memory collectCalls = _collectEncoded(tokenId, _canonicalKey());
        vm.prank(alice);
        lpm.modifyLiquidities(collectCalls, block.timestamp + 1);
        assertGt(IERC20(address(gusd)).balanceOf(alice), aliceGusdBefore, "no gUSD LP fee collected");
        assertEq(IERC20(address(gpu)).balanceOf(alice), aliceGpuBefore, "GPU fee on a BUY?");
    }

    function test_sell_accruesLpFeeInGpu_andHookFeeInGusd() public {
        uint256 tokenId = _setUpLpAlice(1e15);
        uint256 hookBefore = hook.totalTradingFeesAccrued();
        uint256 aliceGpuBefore = IERC20(address(gpu)).balanceOf(alice);
        uint256 aliceGusdBefore = IERC20(address(gusd)).balanceOf(alice);

        GpuRouter.SellParams memory p = GpuRouter.SellParams({
            gpuId: GPU_ID, gpuIn: 5e18, payout: address(gusd), minOut: 1, sqrtLimitX96: 0, recipient: bob
        });
        vm.prank(bob);
        router.sell(p);
        assertGt(hook.totalTradingFeesAccrued() - hookBefore, 0, "no hook fee on sell");

        // LP pool fee: accrued in GPU (input currency on SELL)
        bytes memory collectCalls = _collectEncoded(tokenId, _canonicalKey());
        vm.prank(alice);
        lpm.modifyLiquidities(collectCalls, block.timestamp + 1);
        assertGt(IERC20(address(gpu)).balanceOf(alice) - aliceGpuBefore, 0, "no GPU LP fee collected");
        assertEq(IERC20(address(gusd)).balanceOf(alice), aliceGusdBefore, "gUSD fee on a SELL?");
    }

    function test_decreaseLiquidity_returnsTokens() public {
        uint256 tokenId = _setUpLpAlice(1e15);
        uint256 gusdBefore = IERC20(address(gusd)).balanceOf(alice);
        uint256 gpuBefore = IERC20(address(gpu)).balanceOf(alice);

        bytes memory decreaseCalls = _decreaseEncoded(tokenId, _canonicalKey(), 1e15);
        vm.prank(alice);
        lpm.modifyLiquidities(decreaseCalls, block.timestamp + 1);

        assertGt(IERC20(address(gusd)).balanceOf(alice), gusdBefore);
        assertGt(IERC20(address(gpu)).balanceOf(alice), gpuBefore);
        assertEq(lpm.getPositionLiquidity(tokenId), 0);
    }

    function test_quoter_buyExactIn_matchesExecutedSwap() public {
        _setUpLpAlice(1e15);
        (uint256 quoted,) = quoter.quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({
                poolKey: _canonicalKey(), zeroForOne: gIsC0, exactAmount: 1_000e6, hookData: ""
            })
        );
        assertGt(quoted, 0);

        _dealGusd(bob, 1_000_000e6);
        vm.startPrank(bob);
        IERC20(address(gusd)).approve(address(router), type(uint256).max);
        uint256 gpuOut = router.buyExactIn(GPU_ID, 1_000e6, quoted, 0, bob);
        vm.stopPrank();

        // the quoter runs the hook, so LP fee + hook fee are already inside
        assertEq(gpuOut, quoted);
    }

    function test_quoter_buyExactOut_paidMatchesQuote() public {
        _setUpLpAlice(1e15);
        uint256 gpuWanted = 2e12; // raw gpu-wei
        (uint256 quotedIn,) = quoter.quoteExactOutputSingle(
            IV4Quoter.QuoteExactSingleParams({
                poolKey: _canonicalKey(), zeroForOne: gIsC0, exactAmount: uint128(gpuWanted), hookData: ""
            })
        );
        assertGt(quotedIn, 0);

        _dealGusd(bob, 10_000_000e6);
        vm.startPrank(bob);
        IERC20(address(gusd)).approve(address(router), type(uint256).max);
        GpuRouter.BuyParams memory p = GpuRouter.BuyParams({
            gpuId: GPU_ID,
            gpuOut: gpuWanted,
            poolGpuOut: gpuWanted,
            issueGpuOut: 0,
            payment: address(gusd),
            maxPaid: quotedIn,
            sqrtLimitX96: 0,
            recipient: bob
        });
        uint256 paid = router.buy(p);
        vm.stopPrank();

        assertEq(paid, quotedIn, "executed cost != quoted cost");
    }

    function test_mint_revertsWithoutPermit2Allowance() public {
        address carol = makeAddr("carol");
        _issueGpuTo(carol, 500e18);
        _dealGusd(carol, 10_000_000e6);
        // hoist calldata building (staticcalls) before expectRevert
        PoolKey memory key = _canonicalKey();
        bytes memory calls = _mintEncoded(key, -120, 120, 1e15, carol);
        vm.startPrank(carol);
        // token -> permit2 approved, but permit2 -> PM never approved
        IERC20(address(gusd)).approve(address(permit2), type(uint256).max);
        IERC20(address(gpu)).approve(address(permit2), type(uint256).max);
        vm.expectRevert();
        lpm.modifyLiquidities(calls, block.timestamp + 1);
        vm.stopPrank();
    }
}

contract PositionManagerLpGusdIsCurrency0Test is PositionManagerLpTestBase {
    function _wantGusdIsCurrency0() internal view override returns (bool) {
        return true;
    }
}

contract PositionManagerLpGusdIsCurrency1Test is PositionManagerLpTestBase {
    function _wantGusdIsCurrency0() internal view override returns (bool) {
        return false;
    }
}
