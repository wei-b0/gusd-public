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
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {GUSD} from "../../src/GUSD.sol";
import {RevenueLedger} from "../../src/RevenueLedger.sol";
import {GPUIssuance} from "../../src/GPUIssuance.sol";
import {GPUToken} from "../../src/GPUToken.sol";
import {GPUHook} from "../../src/hooks/GPUHook.sol";
import {GpuRouter} from "../../src/GpuRouter.sol";
import {MockGPUPriceOracle} from "../../src/oracle/MockGPUPriceOracle.sol";
import {IGPUPriceOracle} from "../../src/oracle/IGPUPriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {HookMiner} from "v4-periphery-test/shared/HookMiner.sol";

/// @notice Product-surface rig for GpuRouter: genesis / pool / mixed BUY, SELL,
///         slippage and refund behavior. Runs under both currency orderings.
abstract contract GpuRouterTestBase is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    MockERC20 internal underlying;
    GUSD internal gusd;
    MockGPUPriceOracle internal oracle;
    GPUIssuance internal issuance;
    GPUHook internal hook;
    GpuRouter internal router;
    StateView internal stateView;
    address internal ledger;
    GPUToken internal gpu;
    bytes32 internal GPU_ID;
    bytes32 internal GENESIS_ID;
    address internal alice = makeAddr("alice"); // buyer
    address internal bob = makeAddr("bob"); // seller
    bool internal gIsC0;

    uint24 internal constant POOL_FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    function _wantGusdIsCurrency0() internal view virtual returns (bool);

    function setUp() public virtual {
        vm.warp(1_000_000);
        deployFreshManagerAndRouters();
        underlying = new MockERC20("USD Coin", "USDC", 6);
        gusd = new GUSD(IERC20(address(underlying)), address(this));
        ledger = address(new RevenueLedger(IERC20(address(gusd)), address(this)));
        oracle = new MockGPUPriceOracle(address(this));
        issuance = new GPUIssuance(IERC20(address(gusd)), IGPUPriceOracle(address(oracle)), ledger, address(this));
        GPU_ID = _pickGpuId(_wantGusdIsCurrency0(), "GPU_ROUTER_MAIN");

        bytes memory ctorArgs =
            abi.encode(IPoolManager(address(manager)), address(gusd), issuance, ledger, address(this));
        uint160 flags = uint160(
            Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        (address hookAddr, bytes32 salt) = HookMiner.find(address(this), flags, type(GPUHook).creationCode, ctorArgs);
        hook = GPUHook(hookAddr);
        new GPUHook{salt: salt}(IPoolManager(address(manager)), address(gusd), issuance, ledger, address(this));

        router = new GpuRouter(IPoolManager(address(manager)), gusd, issuance, hook);

        gusd.setRevenueSink(ledger);
        RevenueLedger(ledger).setVault(makeAddr("sgusdVault"));
        RevenueLedger(ledger).setTreasury(makeAddr("treasury"));

        issuance.createGpu(GPU_ID, "GPU hour", "GPU", 50, POOL_FEE, TICK_SPACING);
        issuance.setIssuanceEnabled(GPU_ID, true);
        gpu = GPUToken(issuance.tokenOf(GPU_ID));
        oracle.setPrice(GPU_ID, 25_000, block.timestamp); // 2.5000 gUSD/GPU-hour

        // a second GPU with NO pool: genesis + unregistered-pool tests
        GENESIS_ID = _pickGpuId(_wantGusdIsCurrency0(), "GPU_ROUTER_GENESIS");
        issuance.createGpu(GENESIS_ID, "Genesis GPU", "GGPU", 50, POOL_FEE, TICK_SPACING);
        issuance.setIssuanceEnabled(GENESIS_ID, true);
        oracle.setPrice(GENESIS_ID, 25_000, block.timestamp);

        gIsC0 = address(gusd) < address(gpu);
        manager.initialize(_canonicalKey(), SQRT_PRICE_1_1);
        stateView = new StateView(manager);

        // fund users + approvals to the router
        _dealGusd(alice, 10_000_000e6);
        deal(address(underlying), alice, 10_000_000e6);
        vm.startPrank(alice);
        IERC20(address(gusd)).approve(address(router), type(uint256).max);
        IERC20(address(underlying)).approve(address(router), type(uint256).max);
        vm.stopPrank();
        _issueGpuTo(bob, 1_000e18);
        vm.startPrank(bob);
        IERC20(address(gpu)).approve(address(router), type(uint256).max);
        vm.stopPrank();

        // LP the canonical pool: ~5.98e12 raw per side (issue first: _issueGpuTo
        // deals gUSD absolutely, which would clobber a prior _dealGusd balance)
        _issueGpuTo(address(this), 1_000e18);
        _dealGusd(address(this), 10_000_000e6);
        IERC20(address(gusd)).approve(address(modifyLiquidityRouter), type(uint256).max);
        IERC20(address(gpu)).approve(address(modifyLiquidityRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity(
            _canonicalKey(), ModifyLiquidityParams({tickLower: -120, tickUpper: 120, liquidityDelta: 1e15, salt: 0}), ""
        );
    }

    // ------------------------------------------------------------- helpers

    function _pickGpuId(bool wantTokenAboveGusd, string memory tag) internal view returns (bytes32) {
        for (uint256 i; i < 1024; ++i) {
            bytes32 id = bytes32(bytes(string.concat(tag, vm.toString(i))));
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
        return _canonicalKeyFor(GPU_ID);
    }

    function _canonicalKeyFor(bytes32 gpuId) internal view returns (PoolKey memory) {
        // sorted exactly like the router builds keys (address order)
        address gpuToken = issuance.tokenOf(gpuId);
        (Currency c0, Currency c1) = address(gusd) < gpuToken
            ? (Currency.wrap(address(gusd)), Currency.wrap(gpuToken))
            : (Currency.wrap(gpuToken), Currency.wrap(address(gusd)));
        return PoolKey({currency0: c0, currency1: c1, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: hook});
    }

    function _dealGusd(address to, uint256 gusdAmt) internal {
        deal(address(underlying), to, gusdAmt);
        vm.startPrank(to);
        underlying.approve(address(gusd), type(uint256).max);
        gusd.mint(gusdAmt, to);
        vm.stopPrank();
    }

    function _issueGpuTo(address to, uint256 amount) internal {
        _issueGpuTo(GPU_ID, to, amount);
    }

    function _issueGpuTo(bytes32 gpuId, address to, uint256 amount) internal {
        deal(address(gusd), to, amount * 25_000 / 1e16 + 100e6);
        vm.startPrank(to);
        gusd.approve(address(issuance), type(uint256).max);
        issuance.issue(gpuId, amount, to);
        vm.stopPrank();
    }

    // ---------------------------------------------------------- genesis BUY

    /// Scenario 2: BUY on a brand-new market — zero circulating supply, no
    /// pool at all; 100% primary issuance at oracle + issuance fee.
    function test_genesisBuy_issuanceOnly() public {
        uint256 gpuOut = 10e18; // 10 GPU-hours
        (uint256 base, uint256 issFee,) = issuance.quoteIssue(GENESIS_ID, gpuOut);

        uint256 reserveBefore = issuance.gpuReserve(GENESIS_ID);
        uint256 ledgerBefore = gusd.balanceOf(ledger);
        uint256 aliceGusdBefore = gusd.balanceOf(alice);

        vm.prank(alice);
        uint256 paid = router.buy(
            GpuRouter.BuyParams({
                gpuId: GENESIS_ID,
                gpuOut: gpuOut,
                poolGpuOut: 0,
                issueGpuOut: gpuOut,
                payment: address(gusd),
                maxPaid: base + issFee,
                sqrtLimitX96: 0,
                recipient: alice
            })
        );

        assertEq(paid, base + issFee, "paid = issuance quote");
        assertEq(GPUToken(issuance.tokenOf(GENESIS_ID)).balanceOf(alice), gpuOut, "recipient minted");
        assertEq(issuance.gpuReserve(GENESIS_ID), reserveBefore + base, "reserve grew by base");
        assertEq(gusd.balanceOf(ledger), ledgerBefore + issFee, "issuance fee to ledger");
        assertEq(gusd.balanceOf(alice), aliceGusdBefore - paid, "alice spent quote");
        assertEq(hook.totalTradingFeesAccrued(), 0, "no hook fee on genesis");
        assertEq(gusd.balanceOf(address(router)), 0, "router empty");
    }

    // ------------------------------------------------------------- pool BUY

    /// Scenario 4: BUY filled entirely by the canonical pool, gUSD-funded.
    /// Tight maxPaid; change refunded; hook fee accrued in gUSD.
    function test_buy_viaPool_gusdPayment() public {
        uint256 gpuOut = 1e12; // within the ~5.98e12 raw band
        uint256 hookAccruedBefore = hook.totalTradingFeesAccrued();
        uint256 aliceGusdBefore = gusd.balanceOf(alice);

        vm.prank(alice);
        uint256 paid = router.buy(
            GpuRouter.BuyParams({
                gpuId: GPU_ID,
                gpuOut: gpuOut,
                poolGpuOut: gpuOut,
                issueGpuOut: 0,
                payment: address(gusd),
                maxPaid: 2_000_000e6,
                sqrtLimitX96: 0,
                recipient: alice
            })
        );

        assertEq(gpu.balanceOf(alice), gpuOut, "exact GPU out");
        assertTrue(paid > 0 && paid <= 2_000_000e6, "paid within cap");
        assertEq(gusd.balanceOf(alice), aliceGusdBefore - paid, "alice paid net (change refunded)");
        uint256 hookFee = hook.totalTradingFeesAccrued() - hookAccruedBefore;
        // user pays leg + hook fee; the hook's basis is the raw pool leg
        assertEq(hookFee, _hookFeeOf(paid - hookFee), "hook fee = 0.5% of pool leg");
        assertEq(gusd.balanceOf(address(router)), 0, "router empty");
        assertEq(gusd.balanceOf(address(hook)), hook.totalTradingFeesAccrued() - hook.totalTradingFeesHarvested());
    }

    /// BUY funded with USDC: internal mintUSDC; change still refunds as gUSD.
    function test_buy_viaPool_usdcPayment() public {
        uint256 gpuOut = 1e12;
        uint256 aliceUsdcBefore = underlying.balanceOf(alice);
        uint256 aliceGusdBefore = gusd.balanceOf(alice);

        vm.prank(alice);
        uint256 paid = router.buy(
            GpuRouter.BuyParams({
                gpuId: GPU_ID,
                gpuOut: gpuOut,
                poolGpuOut: gpuOut,
                issueGpuOut: 0,
                payment: address(underlying),
                maxPaid: 2_000_000e6,
                sqrtLimitX96: 0,
                recipient: alice
            })
        );

        assertEq(underlying.balanceOf(alice), aliceUsdcBefore - 2_000_000e6, "USDC pulled = maxPaid");
        assertEq(gpu.balanceOf(alice), gpuOut, "exact GPU out");
        // change refunds as gUSD (mint fee is 0 in this rig)
        assertGt(gusd.balanceOf(alice) - aliceGusdBefore, 0, "gUSD change refunded");
        assertTrue(paid <= 2_000_000e6);
        assertEq(gusd.balanceOf(address(router)), 0);
    }

    /// Scenario 5+6: mixed BUY — pool leg + issuance leg in one tx.
    function test_buy_mixedLegs() public {
        uint256 poolLeg = 5e11;
        uint256 issueLeg = 5e11;
        uint256 gpuOut = poolLeg + issueLeg;
        (uint256 base, uint256 issFee,) = issuance.quoteIssue(GPU_ID, issueLeg);
        uint256 reserveBefore = issuance.gpuReserve(GPU_ID);
        uint256 ledgerBefore = gusd.balanceOf(ledger);
        uint256 hookAccruedBefore = hook.totalTradingFeesAccrued();

        vm.prank(alice);
        uint256 paid = router.buy(
            GpuRouter.BuyParams({
                gpuId: GPU_ID,
                gpuOut: gpuOut,
                poolGpuOut: poolLeg,
                issueGpuOut: issueLeg,
                payment: address(gusd),
                maxPaid: 2_000_000e6,
                sqrtLimitX96: 0,
                recipient: alice
            })
        );

        assertEq(gpu.balanceOf(alice), gpuOut, "both legs delivered");
        assertEq(issuance.gpuReserve(GPU_ID), reserveBefore + base, "issuance reserve grew");
        assertEq(gusd.balanceOf(ledger), ledgerBefore + issFee, "issuance fee to ledger");
        uint256 hookFee = hook.totalTradingFeesAccrued() - hookAccruedBefore;
        // paid = poolLeg + hookFee + (base + issFee); basis = poolLeg only
        assertEq(hookFee, _hookFeeOf(paid - hookFee - base - issFee), "hook fee on pool leg only");
        assertEq(gusd.balanceOf(address(router)), 0);
    }

    function _hookFeeOf(uint256 basis) internal pure returns (uint256) {
        return (basis * 50 + 9_999) / 10_000; // ceil(basis * 0.5%)
    }

    // --------------------------------------------------------- BUY failures

    function test_buy_maxPaidExceeded() public {
        vm.prank(alice);
        vm.expectRevert(GpuRouter.MaxPaidExceeded.selector);
        router.buy(
            GpuRouter.BuyParams({
                gpuId: GPU_ID,
                gpuOut: 1e12,
                poolGpuOut: 1e12,
                issueGpuOut: 0,
                payment: address(gusd),
                maxPaid: 1,
                sqrtLimitX96: 0,
                recipient: alice
            })
        );
    }

    function test_buy_poolShortfall() public {
        vm.prank(alice);
        vm.expectRevert(GpuRouter.PoolShortfall.selector);
        router.buy(
            GpuRouter.BuyParams({
                gpuId: GPU_ID,
                gpuOut: 1e15,
                poolGpuOut: 1e15,
                issueGpuOut: 0,
                payment: address(gusd),
                maxPaid: 10_000_000e6,
                sqrtLimitX96: 0,
                recipient: alice
            })
        );
    }

    /// Scenario 12: stale oracle — issuance leg reverts, pool-only BUY works.
    function test_buy_staleOracle_poolOnlyStillWorks() public {
        vm.warp(block.timestamp + 30 days);
        vm.prank(alice);
        vm.expectRevert();
        router.buy(
            GpuRouter.BuyParams({
                gpuId: GPU_ID,
                gpuOut: 5e11,
                poolGpuOut: 0,
                issueGpuOut: 5e11,
                payment: address(gusd),
                maxPaid: 1_000e6,
                sqrtLimitX96: 0,
                recipient: alice
            })
        );

        uint256 aliceGpuBefore = gpu.balanceOf(alice);
        vm.prank(alice);
        router.buy(
            GpuRouter.BuyParams({
                gpuId: GPU_ID,
                gpuOut: 1e12,
                poolGpuOut: 1e12,
                issueGpuOut: 0,
                payment: address(gusd),
                maxPaid: 2_000_000e6,
                sqrtLimitX96: 0,
                recipient: alice
            })
        );
        assertEq(gpu.balanceOf(alice) - aliceGpuBefore, 1e12);
    }

    function test_buy_paramValidation() public {
        vm.startPrank(alice);
        vm.expectRevert(GpuRouter.LegMismatch.selector);
        router.buy(
            GpuRouter.BuyParams({
                gpuId: GPU_ID,
                gpuOut: 10,
                poolGpuOut: 3,
                issueGpuOut: 6,
                payment: address(gusd),
                maxPaid: 100,
                sqrtLimitX96: 0,
                recipient: alice
            })
        );
        vm.expectRevert(GpuRouter.UnsupportedPayment.selector);
        router.buy(
            GpuRouter.BuyParams({
                gpuId: GPU_ID,
                gpuOut: 10,
                poolGpuOut: 0,
                issueGpuOut: 10,
                payment: address(0xBEEF),
                maxPaid: 100,
                sqrtLimitX96: 0,
                recipient: alice
            })
        );
        vm.expectRevert(GpuRouter.UnknownGpu.selector);
        router.buy(
            GpuRouter.BuyParams({
                gpuId: bytes32("NOPE"),
                gpuOut: 10,
                poolGpuOut: 0,
                issueGpuOut: 10,
                payment: address(gusd),
                maxPaid: 100,
                sqrtLimitX96: 0,
                recipient: alice
            })
        );
        vm.stopPrank();
    }

    // ---------------------------------------------------------- buyExactIn

    function test_buyExactIn_fullFill() public {
        uint256 gusdMaxIn = 1e9; // 1,000 gUSD, well within the band
        uint256 minGpuOut = 9e8;
        uint256 hookAccruedBefore = hook.totalTradingFeesAccrued();
        uint256 aliceGusdBefore = gusd.balanceOf(alice);

        vm.prank(alice);
        uint256 gpuOut = router.buyExactIn(GPU_ID, gusdMaxIn, minGpuOut, 0, alice);

        assertGt(gpuOut, minGpuOut, "full fill");
        assertEq(gusd.balanceOf(alice), aliceGusdBefore - gusdMaxIn, "paid exactly gusdMaxIn");
        assertEq(hook.totalTradingFeesAccrued() - hookAccruedBefore, _hookFeeOf(gusdMaxIn), "fee on gross input");
        assertEq(gusd.balanceOf(address(router)), 0);
        assertEq(gpu.balanceOf(address(router)), 0);
    }

    function test_buyExactIn_slippage() public {
        vm.prank(alice);
        vm.expectRevert(GpuRouter.Slippage.selector);
        router.buyExactIn(GPU_ID, 1e9, 5e12, 0, alice); // minGpuOut unreachable
    }

    /// Pool cannot absorb the full input: the hook's all-or-nothing rule
    /// reverts the whole trade (PartialFillNotSupported, wrapped by core).
    function test_buyExactIn_partialFillReverts() public {
        vm.prank(alice);
        vm.expectRevert();
        router.buyExactIn(GPU_ID, 10_000_000e6, 0, 0, alice);
    }

    function test_buyExactIn_requiresCanonicalPool() public {
        vm.prank(alice);
        vm.expectRevert(GpuRouter.NotCanonicalPool.selector);
        router.buyExactIn(GENESIS_ID, 1e9, 0, 0, alice);
    }

    // --------------------------------------------------------------- SELL

    /// Scenario 7: SELL via secondary, gUSD payout.
    function test_sell_gusdPayout() public {
        uint256 gpuIn = 1e12;
        uint256 hookAccruedBefore = hook.totalTradingFeesAccrued();
        uint256 bobGusdBefore = gusd.balanceOf(bob);
        uint256 bobGpuBefore = gpu.balanceOf(bob);

        vm.prank(bob);
        uint256 out = router.sell(
            GpuRouter.SellParams({
                gpuId: GPU_ID, gpuIn: gpuIn, payout: address(gusd), minOut: 1, sqrtLimitX96: 0, recipient: bob
            })
        );

        assertGt(out, 0, "received gUSD");
        assertEq(gusd.balanceOf(bob), bobGusdBefore + out);
        assertEq(gpu.balanceOf(bob), bobGpuBefore - gpuIn, "GPU pulled");
        uint256 hookFee = hook.totalTradingFeesAccrued() - hookAccruedBefore;
        // basis = raw pool leg = net gUSD out + hook fee (fee carved from it)
        assertEq(hookFee, _hookFeeOf(out + hookFee), "fee on raw gUSD out");
        assertEq(gusd.balanceOf(address(router)), 0);
        assertEq(gpu.balanceOf(address(router)), 0);
    }

    /// SELL with USDC payout: minOut grossed up for the redeem fee; the
    /// redeem fee lands in the ledger.
    function test_sell_usdcPayout_redeemFeeGrossUp() public {
        gusd.setFees(0, 100); // 1% redeem fee
        uint256 gpuIn = 1e12;
        uint256 minOut = 5e11; // USDC units
        // requiredGusd = ceil(minOut * 10000 / 9900)
        uint256 requiredGusd = (minOut * 10_000 + 9_899) / 9_900;
        uint256 hookAccruedBefore = hook.totalTradingFeesAccrued();
        uint256 ledgerBefore = gusd.balanceOf(ledger);
        uint256 supplyBefore = gusd.totalSupply();
        uint256 bobUsdcBefore = underlying.balanceOf(bob);

        vm.prank(bob);
        uint256 out = router.sell(
            GpuRouter.SellParams({
                gpuId: GPU_ID, gpuIn: gpuIn, payout: address(underlying), minOut: minOut, sqrtLimitX96: 0, recipient: bob
            })
        );

        assertGe(out, minOut, "payout bound holds after redeem fee");
        assertEq(underlying.balanceOf(bob), bobUsdcBefore + out);
        // exact gusdNet from supply accounting: dSupply = -gusdNet + redeemFee
        uint256 redeemFee = gusd.balanceOf(ledger) - ledgerBefore;
        uint256 gusdNet = redeemFee + (supplyBefore - gusd.totalSupply());
        assertGt(redeemFee, 0, "redeem fee to ledger");
        assertEq(out, gusdNet - redeemFee, "out = gusdNet net of redeem fee");
        uint256 hookFee = hook.totalTradingFeesAccrued() - hookAccruedBefore;
        assertEq(hookFee, _hookFeeOf(gusdNet + hookFee), "hook fee on raw leg");
        assertEq(gusd.balanceOf(address(router)), 0);
    }

    /// Empty pool (initialized, zero liquidity): SELL fails cleanly.
    function test_sell_emptyPoolRevertsCleanly() public {
        manager.initialize(_canonicalKeyFor(GENESIS_ID), SQRT_PRICE_1_1); // no LP
        GPUToken genGpu = GPUToken(issuance.tokenOf(GENESIS_ID));
        _issueGpuTo(GENESIS_ID, bob, 10e18);
        vm.startPrank(bob);
        genGpu.approve(address(router), type(uint256).max);
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(GpuRouter.Slippage.selector);
        router.sell(
            GpuRouter.SellParams({
                gpuId: GENESIS_ID, gpuIn: 1e12, payout: address(gusd), minOut: 1, sqrtLimitX96: 0, recipient: bob
            })
        );
    }

    /// Oversized SELL: partial fill pro-rates the fee; unconsumed GPU
    /// returns to the seller.
    function test_sell_partialFill_returnsLeftover() public {
        uint256 gpuIn = 1e15; // ~167x the band
        uint256 hookAccruedBefore = hook.totalTradingFeesAccrued();
        uint256 bobGpuBefore = gpu.balanceOf(bob);

        vm.prank(bob);
        uint256 out = router.sell(
            GpuRouter.SellParams({
                gpuId: GPU_ID, gpuIn: gpuIn, payout: address(gusd), minOut: 1, sqrtLimitX96: 0, recipient: bob
            })
        );

        uint256 consumed = bobGpuBefore - gpu.balanceOf(bob);
        assertLt(consumed, gpuIn, "partial fill");
        assertGt(out, 0);
        uint256 hookFee = hook.totalTradingFeesAccrued() - hookAccruedBefore;
        assertEq(hookFee, _hookFeeOf(out + hookFee), "fee pro-rated on actual leg");
        assertEq(gusd.balanceOf(address(router)), 0);
        assertEq(gpu.balanceOf(address(router)), 0);
    }

    function test_sell_slippage() public {
        vm.prank(bob);
        vm.expectRevert(GpuRouter.Slippage.selector);
        router.sell(
            GpuRouter.SellParams({
                gpuId: GPU_ID, gpuIn: 1e12, payout: address(gusd), minOut: 5e13, sqrtLimitX96: 0, recipient: bob
            })
        );
    }

    function test_sell_requiresCanonicalPool() public {
        vm.prank(bob);
        vm.expectRevert(GpuRouter.NotCanonicalPool.selector);
        router.sell(
            GpuRouter.SellParams({
                gpuId: GENESIS_ID, gpuIn: 1e12, payout: address(gusd), minOut: 1, sqrtLimitX96: 0, recipient: bob
            })
        );
    }

    // ------------------------------------------------------------- scenario 3+8 sanity

    /// LP fee accrues to the pool independently of the hook fee (both fees
    /// from the same trade are separately observable).
    function test_buy_lpFeeAndHookFeeIndependent() public {
        (,, uint24 packedProtocolFee, uint24 lpFee) = stateView.getSlot0(_canonicalKey().toId());
        assertEq(packedProtocolFee, 0);
        assertEq(lpFee, POOL_FEE);

        (uint256 g0, uint256 g1) = stateView.getFeeGrowthGlobals(_canonicalKey().toId());
        vm.prank(alice);
        router.buy(
            GpuRouter.BuyParams({
                gpuId: GPU_ID,
                gpuOut: 1e12,
                poolGpuOut: 1e12,
                issueGpuOut: 0,
                payment: address(gusd),
                maxPaid: 2_000_000e6,
                sqrtLimitX96: 0,
                recipient: alice
            })
        );
        (uint256 g0b, uint256 g1b) = stateView.getFeeGrowthGlobals(_canonicalKey().toId());
        bool zeroForOne = gIsC0;
        if (zeroForOne) {
            assertGt(g0b, g0, "LP fee accrued in gUSD input side");
            assertEq(g1b, g1);
        } else {
            assertGt(g1b, g1, "LP fee accrued in gUSD input side");
            assertEq(g0b, g0);
        }
        assertGt(hook.totalTradingFeesAccrued(), 0, "hook fee accrued too");
    }
}

/// Concrete orderings: every test runs under both currency orderings.
contract RouterGusdIsCurrency0Test is GpuRouterTestBase {
    function _wantGusdIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract RouterGusdIsCurrency1Test is GpuRouterTestBase {
    function _wantGusdIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}
