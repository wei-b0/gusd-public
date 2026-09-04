// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateView} from "@uniswap/v4-periphery/lens/StateView.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {GUSD} from "../../src/GUSD.sol";
import {RevenueLedger} from "../../src/RevenueLedger.sol";
import {GPUIssuance} from "../../src/GPUIssuance.sol";
import {GPUToken} from "../../src/GPUToken.sol";
import {GPUHook} from "../../src/hooks/GPUHook.sol";
import {MockGPUPriceOracle} from "../../src/oracle/MockGPUPriceOracle.sol";
import {IGPUPriceOracle} from "../../src/oracle/IGPUPriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {HookMiner} from "v4-periphery-test/shared/HookMiner.sol";

/// @notice Fee-matrix + registration rig for GPUHook v2. The same suite runs
///         under both currency orderings: `_wantGusdIsCurrency0` brute-forces
///         a GPU id whose CREATE2 token address lands on the requested side of
///         gUSD, so every test executes with gUSD = currency0 and again with
///         gUSD = currency1.
abstract contract GPUHookTestBase is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    MockERC20 internal usdc;
    GUSD internal gusd;
    MockGPUPriceOracle internal oracle;
    GPUIssuance internal issuance;
    GPUHook internal hook;
    StateView internal stateView;
    address internal ledger;
    GPUToken internal gpu;
    bytes32 internal GPU_ID;
    bool internal gIsC0;

    uint16 internal constant HOOK_FEE_BPS = 50; // shipped default
    uint24 internal constant POOL_FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    function _wantGusdIsCurrency0() internal view virtual returns (bool);

    function setUp() public virtual {
        vm.warp(1_000_000);
        deployFreshManagerAndRouters();
        usdc = new MockERC20("USD Coin", "USDC", 6);
        gusd = new GUSD(IERC20(address(usdc)), address(this));
        ledger = address(new RevenueLedger(IERC20(address(gusd)), address(this)));
        oracle = new MockGPUPriceOracle(address(this));
        issuance = new GPUIssuance(IERC20(address(gusd)), IGPUPriceOracle(address(oracle)), ledger, address(this));
        GPU_ID = _pickGpuId(_wantGusdIsCurrency0());

        // mine a salt so the low 14 bits equal the v2 flag set (0x10CC)
        bytes memory ctorArgs =
            abi.encode(IPoolManager(address(manager)), address(gusd), issuance, ledger, address(this));
        uint160 flags = uint160(
            Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        (address hookAddr, bytes32 salt) = HookMiner.find(address(this), flags, type(GPUHook).creationCode, ctorArgs);
        hook = GPUHook(hookAddr);
        new GPUHook{salt: salt}(IPoolManager(address(manager)), address(gusd), issuance, ledger, address(this));

        gusd.setRevenueSink(ledger);
        RevenueLedger(ledger).setVault(makeAddr("sgusdVault"));
        RevenueLedger(ledger).setTreasury(makeAddr("treasury"));
        issuance.createGpu(GPU_ID, "GPU hour", "GPU", 50, POOL_FEE, TICK_SPACING);
        issuance.setIssuanceEnabled(GPU_ID, true);
        gpu = GPUToken(issuance.tokenOf(GPU_ID));
        oracle.setPrice(GPU_ID, 25_000, block.timestamp); // 2.5000 gUSD/GPU
        gIsC0 = address(gusd) < address(gpu);
        manager.initialize(_canonicalKey(), SQRT_PRICE_1_1);
        stateView = new StateView(manager);

        // Approve the swap router once: _swap must not emit Approval events,
        // which would consume vm.expectEmit/vm.expectRevert expectations.
        IERC20(address(gusd)).approve(address(swapRouter), type(uint256).max);
        IERC20(address(gpu)).approve(address(swapRouter), type(uint256).max);

        // LP the pool: small ±120 band around 1:1 (~6 units of depth per side)
        _dealBoth(address(this), 1_000_000e6, 0);
        _issueGpu(address(this), 1_000_000e18);
        IERC20(address(gusd)).approve(address(modifyLiquidityRouter), type(uint256).max);
        IERC20(address(gpu)).approve(address(modifyLiquidityRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity(
            _canonicalKey(), ModifyLiquidityParams({tickLower: -120, tickUpper: 120, liquidityDelta: 1e15, salt: 0}), ""
        );
    }

    // ------------------------------------------------------------- helpers

    /// @dev Brute-forces a GPU id whose CREATE2 token address satisfies the
    ///      requested ordering relative to gUSD (expected ~2 iterations).
    function _pickGpuId(bool wantTokenAboveGusd) internal view returns (bytes32) {
        for (uint256 i; i < 1024; ++i) {
            bytes32 id = bytes32(bytes(string.concat("GPU_V2_TEST_", vm.toString(i))));
            address predicted = vm.computeCreate2Address(
                id,
                keccak256(
                    abi.encodePacked(type(GPUToken).creationCode, abi.encode(address(issuance), id, "GPU hour", "GPU"))
                ),
                address(issuance)
            );
            if (wantTokenAboveGusd ? predicted > address(gusd) : predicted < address(gusd)) return id;
        }
        revert("no gpu id on requested side");
    }

    function _canonicalKey() internal view returns (PoolKey memory) {
        (Currency c0, Currency c1) = gIsC0
            ? (Currency.wrap(address(gusd)), Currency.wrap(address(gpu)))
            : (Currency.wrap(address(gpu)), Currency.wrap(address(gusd)));
        return PoolKey({currency0: c0, currency1: c1, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: hook});
    }

    /// @dev BUY = gUSD -> GPU: zeroForOne iff gUSD is currency0.
    function _buyZeroForOne() internal view returns (bool) {
        return gIsC0;
    }

    function _dealBoth(address to, uint256 gusdAmt, uint256 gpuAmt) internal {
        deal(address(usdc), to, gusdAmt);
        vm.startPrank(to);
        usdc.approve(address(gusd), type(uint256).max);
        gusd.mintUSDC(gusdAmt, to);
        vm.stopPrank();
    }

    /// @dev Mints GPU tokens to `to` by paying issuance from gUSD.
    function _issueGpu(address to, uint256 amount) internal {
        deal(address(gusd), to, amount + 100e6);
        vm.startPrank(to);
        gusd.approve(address(issuance), type(uint256).max);
        issuance.issue(GPU_ID, amount, to);
        vm.stopPrank();
    }

    function _hookFeeFor(uint256 basis) internal view returns (uint256) {
        return Math.mulDiv(basis, HOOK_FEE_BPS, 10_000, Math.Rounding.Ceil);
    }

    /// @dev Swaps from the test contract; returns the swapper's gUSD balance delta.
    function _swap(bool zeroForOne, int256 amountSpecified) internal returns (int256 gusdDelta) {
        uint256 gBefore = gusd.balanceOf(address(this));
        swapRouter.swap(
            _canonicalKey(),
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        gusdDelta = int256(gusd.balanceOf(address(this))) - int256(gBefore);
    }

    /// @dev Like _swap but without the balance read: a vm.expectRevert placed
    ///      before it observes the swap call itself, not a staticcall.
    function _swapRaw(bool zeroForOne, int256 amountSpecified) internal {
        swapRouter.swap(
            _canonicalKey(),
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    // ------------------------------------------------------- registration

    function test_hookAddressFlagsV2() public view {
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, 0x10CC);
        assertEq(hook.hookFeeBps(), HOOK_FEE_BPS);
    }

    function test_canonicalPoolRegisters() public view {
        assertEq(hook.poolGpuId(_canonicalKey().toId()), GPU_ID);
    }

    function test_wrongFeeTierReverts() public {
        PoolKey memory key = _canonicalKey();
        key.fee = 500;
        vm.expectRevert(); // WrappedError(NotCanonicalPool) bubbles through core
        manager.initialize(key, SQRT_PRICE_1_1);
    }

    function test_wrongTickSpacingReverts() public {
        PoolKey memory key = _canonicalKey();
        key.tickSpacing = 10;
        vm.expectRevert();
        manager.initialize(key, SQRT_PRICE_1_1);
    }

    function test_unknownGpuTokenReverts() public {
        MockERC20 fake = new MockERC20("FAKE", "FK", 18);
        (Currency c0, Currency c1) = address(fake) < address(gusd)
            ? (Currency.wrap(address(fake)), Currency.wrap(address(gusd)))
            : (Currency.wrap(address(gusd)), Currency.wrap(address(fake)));
        PoolKey memory key =
            PoolKey({currency0: c0, currency1: c1, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: hook});
        vm.expectRevert();
        manager.initialize(key, SQRT_PRICE_1_1);
    }

    function test_gusdBothSidesReverts() public {
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(gusd)),
            currency1: Currency.wrap(address(gusd)),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: hook
        });
        vm.expectRevert();
        manager.initialize(key, SQRT_PRICE_1_1);
    }

    // --------------------------------------------------------- fee policy

    function test_setHookFeeBpsBounds() public {
        hook.setHookFeeBps(100);
        assertEq(hook.hookFeeBps(), 100);
        vm.expectRevert(GPUHook.FeeTooLarge.selector);
        hook.setHookFeeBps(1001);
        hook.setHookFeeBps(0);
        assertEq(hook.hookFeeBps(), 0);
    }

    // --------------------------------------------------------- fee matrix

    /// BUY exact-in: gUSD is the specified currency -> beforeSwap charges the
    /// fee up front (pool swaps N - fee), afterSwap realizes it. User pays N.
    function test_buyExactIn_feeAccruesInGusd() public {
        PoolKey memory key = _canonicalKey();
        uint256 n = 2e6; // 2 gUSD in, ~6 units of depth: full fill
        uint256 fee = _hookFeeFor(n);
        assertTrue(fee > 0);

        uint256 hookBalBefore = gusd.balanceOf(address(hook));
        uint256 gpuBefore = gpu.balanceOf(address(this));
        vm.expectEmit(true, true, true, true, address(hook));
        emit GPUHook.TradingFeeAccrued(key.toId(), GPU_ID, true, fee);
        int256 gusdDelta = _swap(_buyZeroForOne(), -int256(n));
        vm.stopPrank();

        assertEq(gusdDelta, -int256(n), "user pays exactly N");
        assertGt(gpu.balanceOf(address(this)), gpuBefore, "received GPU");
        assertEq(gusd.balanceOf(address(hook)) - hookBalBefore, fee, "hook holds the fee");
        assertEq(hook.totalTradingFeesAccrued(), fee);
        assertEq(hook.poolTradingFeesAccrued(key.toId()), fee);
        assertEq(hook.totalTradingFeesHarvested(), 0);
    }

    /// BUY exact-out: gUSD is unspecified -> afterSwap takes the fee and the
    /// matching return delta debits the swapper. Basis = raw gUSD paid.
    function test_buyExactOut_feeAccruesInGusd() public {
        uint256 gpuOut = 1e18; // far beyond the band: partial fill, pro-rated
        uint256 hookBalBefore = gusd.balanceOf(address(hook));
        uint256 gusdBefore = gusd.balanceOf(address(this));
        uint256 accruedBefore = hook.totalTradingFeesAccrued();

        _swap(_buyZeroForOne(), int256(gpuOut));
        vm.stopPrank();

        // The hook's basis is the raw pool gUSD leg, which excludes the hook
        // fee itself: userPaid = poolLeg + fee.
        uint256 rawPaid = gusdBefore - gusd.balanceOf(address(this));
        uint256 fee = hook.totalTradingFeesAccrued() - accruedBefore;
        assertGt(fee, 0);
        assertEq(fee, _hookFeeFor(rawPaid - fee), "fee = 0.5% of raw pool leg");
        assertEq(hook.totalTradingFeesAccrued(), fee);
    }

    /// SELL exact-in: gUSD is unspecified -> afterSwap takes fee off the raw
    /// gUSD received; matching return delta debits the swapper.
    function test_sellExactIn_feeAccruesInGusd() public {
        uint256 gpuIn = 1e18; // far beyond the band: partial fill, pro-rated
        uint256 hookBalBefore = gusd.balanceOf(address(hook));
        uint256 gusdBefore = gusd.balanceOf(address(this));
        uint256 accruedBefore = hook.totalTradingFeesAccrued();

        _swap(!_buyZeroForOne(), -int256(gpuIn));
        vm.stopPrank();

        // The hook's basis is the raw pool gUSD leg, which excludes the hook
        // fee itself: userReceived = poolLeg - fee.
        uint256 rawOut = gusd.balanceOf(address(this)) - gusdBefore;
        uint256 fee = hook.totalTradingFeesAccrued() - accruedBefore;
        assertGt(rawOut, 0);
        assertGt(fee, 0);
        assertEq(fee, _hookFeeFor(rawOut + fee), "fee = 0.5% of raw pool leg");
        assertEq(gusd.balanceOf(address(hook)) - hookBalBefore, fee);
        assertEq(hook.totalTradingFeesAccrued(), accruedBefore + fee);
    }

    /// SELL exact-out: gUSD (output) is specified -> beforeSwap credits +fee,
    /// pool produces N + fee, swapper nets exactly N, afterSwap realizes.
    function test_sellExactOut_feeAccruesInGusd() public {
        uint256 n = 1e6; // 1 gUSD out
        uint256 fee = _hookFeeFor(n);
        uint256 hookBalBefore = gusd.balanceOf(address(hook));
        uint256 gusdBefore = gusd.balanceOf(address(this));

        _swap(!_buyZeroForOne(), int256(n));
        vm.stopPrank();

        assertEq(gusd.balanceOf(address(this)) - gusdBefore, n, "swapper receives exactly N");
        assertEq(gusd.balanceOf(address(hook)) - hookBalBefore, fee);
        assertEq(hook.totalTradingFeesAccrued(), fee);
    }

    // ---------------------------------------------- partial fill + guards

    /// BUY/SELL exact-in/out trades the pool cannot fully execute revert
    /// instead of silently charging the committed fee (all-or-nothing).
    function test_partialFillReverts_bothSpecifiedShapes() public {
        // per-side depth is ~5.98e12 raw gUSD; 1e13 blows through the band
        vm.expectRevert(); // PartialFillNotSupported, wrapped by core
        _swapRaw(_buyZeroForOne(), -int256(10_000_000e6));
    }

    function test_sellExactOut_partialFillReverts() public {
        vm.expectRevert();
        _swapRaw(!_buyZeroForOne(), int256(10_000_000e6));
    }

    /// A 1-wei gUSD leg would pay a 1-wei fee (fee >= basis): revert.
    function test_dustGusdLegReverts() public {
        vm.expectRevert(); // FeeExceedsSwap, wrapped by core
        _swapRaw(_buyZeroForOne(), -1);
        vm.stopPrank();
    }

    function test_zeroHookFee_noFeeNoTake() public {
        hook.setHookFeeBps(0);
        uint256 gpuBefore = gpu.balanceOf(address(this));
        uint256 gusdBefore = gusd.balanceOf(address(this));

        _swap(_buyZeroForOne(), -int256(1e6));
        vm.stopPrank();

        assertGt(gpu.balanceOf(address(this)), gpuBefore);
        assertEq(hook.totalTradingFeesAccrued(), 0);
        assertEq(gusd.balanceOf(address(hook)), 0);
        assertEq(gusd.balanceOf(address(this)), gusdBefore - 1e6);
    }

    // --------------------------------------------- LP fee independence

    /// LP pool fee accrues to LPs independently of the hook fee; the native
    /// protocol fee stays zero (the hook owns the entire protocol share).
    function test_lpFeeAccrues_and_nativeProtocolFeeStaysZero() public {
        (,, uint24 packedProtocolFee, uint24 lpFee) = stateView.getSlot0(_canonicalKey().toId());
        assertEq(packedProtocolFee, 0, "no native protocol fee configured");
        assertEq(lpFee, POOL_FEE, "static pool fee active");

        uint256 growth0Before;
        uint256 growth1Before;
        (growth0Before, growth1Before) = stateView.getFeeGrowthGlobals(_canonicalKey().toId());
        uint256 gpuBefore = gpu.balanceOf(address(this));
        _swap(_buyZeroForOne(), -int256(1e6));
        vm.stopPrank();
        assertGt(gpu.balanceOf(address(this)), gpuBefore);

        (uint256 growth0After, uint256 growth1After) = stateView.getFeeGrowthGlobals(_canonicalKey().toId());
        bool zeroForOne = _buyZeroForOne();
        if (zeroForOne) {
            assertGt(growth0After, growth0Before, "LP fee accrued in gUSD (input side)");
            assertEq(growth1After, growth1Before);
        } else {
            assertGt(growth1After, growth1Before, "LP fee accrued in gUSD (input side)");
            assertEq(growth0After, growth0Before);
        }
    }

    // ------------------------------------------------------------- harvest

    function test_harvest_movesAccruedFeesToLedger() public {
        PoolKey memory key = _canonicalKey();
        _swap(_buyZeroForOne(), -int256(2e6));
        vm.stopPrank();
        uint256 fee = hook.totalTradingFeesAccrued();
        assertTrue(fee > 0);

        uint256 ledgerBefore = gusd.balanceOf(ledger);
        vm.expectEmit(true, true, true, true, address(hook));
        emit GPUHook.TradingFeesHarvested(key.toId(), fee);
        hook.harvestTradingFees(key.toId(), 0);
        assertEq(gusd.balanceOf(ledger) - ledgerBefore, fee);
        assertEq(hook.pendingTradingFees(key.toId()), 0);
        assertEq(hook.totalTradingFeesHarvested(), fee);
        // balance invariant: hook holds exactly accrued - harvested
        assertEq(gusd.balanceOf(address(hook)), hook.totalTradingFeesAccrued() - hook.totalTradingFeesHarvested());

        // second harvest is a no-op
        hook.harvestTradingFees(key.toId(), 0);
        assertEq(gusd.balanceOf(ledger), ledgerBefore + fee);

        // over-harvest reverts
        vm.expectRevert(GPUHook.HarvestExceedsPending.selector);
        hook.harvestTradingFees(key.toId(), 1);
    }

    /// Donations to the hook are stranded by design: harvest moves tracked
    /// counters, never the raw balance.
    function test_donationIsNotHarvestable() public {
        PoolKey memory key = _canonicalKey();
        _swap(_buyZeroForOne(), -int256(1e6));
        vm.stopPrank();
        uint256 accrued = hook.totalTradingFeesAccrued();
        assertTrue(accrued > 0);

        deal(address(gusd), address(hook), gusd.balanceOf(address(hook)) + 100e6);
        assertEq(hook.pendingTradingFees(key.toId()), accrued);

        uint256 ledgerBefore = gusd.balanceOf(ledger);
        hook.harvestTradingFees(key.toId(), 0);
        assertEq(gusd.balanceOf(ledger) - ledgerBefore, accrued, "only tracked fees move");
        assertGt(gusd.balanceOf(address(hook)), 0, "donation stranded");
    }

    /// Fees flow through the ledger like any other protocol revenue.
    function test_harvestedFeesFlowThroughLedger() public {
        _swap(_buyZeroForOne(), -int256(2e6));
        vm.stopPrank();
        hook.harvestTradingFees(_canonicalKey().toId(), 0);
        assertGt(gusd.balanceOf(ledger), 0);

        RevenueLedger(ledger).distribute();
        assertEq(gusd.balanceOf(ledger), 0);
        assertGt(RevenueLedger(ledger).totalToVault() + RevenueLedger(ledger).totalToTreasury(), 0);
    }
}

/// Concrete orderings: every test in GPUHookTestBase runs under both.
contract GusdIsCurrency0Test is GPUHookTestBase {
    function _wantGusdIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract GusdIsCurrency1Test is GPUHookTestBase {
    function _wantGusdIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}
