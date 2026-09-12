// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {StateView} from "@uniswap/v4-periphery/lens/StateView.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {GUSD} from "../../src/GUSD.sol";
import {RevenueLedger} from "../../src/RevenueLedger.sol";
import {GPUIssuance} from "../../src/GPUIssuance.sol";
import {GPUMarketLiquidity} from "../../src/GPUMarketLiquidity.sol";
import {GPUToken} from "../../src/GPUToken.sol";
import {GPUHook} from "../../src/hooks/GPUHook.sol";
import {GpuRouter} from "../../src/GpuRouter.sol";
import {GpuQuoter} from "../../src/lens/GpuQuoter.sol";
import {MockGPUPriceOracle} from "../../src/oracle/MockGPUPriceOracle.sol";
import {IGPUPriceOracle} from "../../src/oracle/IGPUPriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {HookMiner} from "v4-periphery-test/shared/HookMiner.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

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
    GpuQuoter internal gq;
    int24 internal initTick;
    GPUMarketLiquidity internal pol;
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
        pol = new GPUMarketLiquidity(IERC20(address(gusd)), address(manager), address(this));
        issuance = new GPUIssuance(IERC20(address(gusd)), IGPUPriceOracle(address(oracle)), ledger, address(pol), address(this));
        GPU_ID = _pickGpuId(_wantGusdIsCurrency0(), "GPU_ROUTER_MAIN");

        bytes memory ctorArgs =
            abi.encode(IPoolManager(address(manager)), address(gusd), oracle, issuance, ledger, address(this));
        uint160 flags = uint160(
            Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        (address hookAddr, bytes32 salt) = HookMiner.find(address(this), flags, type(GPUHook).creationCode, ctorArgs);
        hook = GPUHook(hookAddr);
        new GPUHook{salt: salt}(IPoolManager(address(manager)), address(gusd), oracle, issuance, ledger, address(this));

        router = new GpuRouter(IPoolManager(address(manager)), gusd, issuance, hook);
        pol.setRefs(address(issuance), address(hook));

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
        // init at the oracle reference ($2.50/GPU-hour) so the native book
        // sits at the hook's edges (the C-max merged-book geometry)
        initTick = gIsC0 ? int24(267_120) : int24(-267_120); // spacing-aligned (raw ref ~267_161)
        manager.initialize(_canonicalKey(), TickMath.getSqrtPriceAtTick(initTick));
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

        // LP the canonical pool around the oracle anchor (issue first:
        // _issueGpuTo deals gUSD absolutely, which would clobber a prior
        // _dealGusd balance)
        _issueGpuTo(address(this), 1_000e18);
        _dealGusd(address(this), 10_000_000e6);
        IERC20(address(gusd)).approve(address(modifyLiquidityRouter), type(uint256).max);
        IERC20(address(gpu)).approve(address(modifyLiquidityRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity(
            _canonicalKey(),
            ModifyLiquidityParams({tickLower: initTick - 120, tickUpper: initTick + 120, liquidityDelta: 1e15, salt: 0}),
            ""
        );

        // executable-quote lens + deploy-posture hook fee
        gq = new GpuQuoter(IPoolManager(address(manager)), address(gusd), issuance, address(this));
        IERC20(address(gusd)).approve(address(gq), type(uint256).max);
        gq.setGusdFloat(1_000_000e6);
        hook.setHookFeeBps(50);
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

    /// BUY on a brand-new market: no registered pool -> 100% primary
    /// issuance fallback (zero v4 dependency), principal -> vault instantly.
    function test_genesisBuy_issuanceOnly() public {
        uint256 gpuOut = 10e18; // 10 GPU-hours
        (uint256 base, uint256 issFee,) = issuance.quoteIssue(GENESIS_ID, gpuOut);

        uint256 ledgerBefore = gusd.balanceOf(ledger);
        uint256 aliceGusdBefore = gusd.balanceOf(alice);

        vm.prank(alice);
        uint256 paid = router.buy(
            GpuRouter.BuyParams({
                gpuId: GENESIS_ID, gpuOut: gpuOut, payment: address(gusd), maxPaid: base + issFee,
                deadline: 0, sqrtLimitX96: 0, recipient: alice
            })
        );

        assertEq(paid, base + issFee, "paid = issuance quote");
        assertEq(GPUToken(issuance.tokenOf(GENESIS_ID)).balanceOf(alice), gpuOut, "recipient minted");
        assertEq(pol.principalContributed(GENESIS_ID), base, "principal capitalized immediately");
        assertGt(pol.bidInventoryGusd(GENESIS_ID), 0, "principal is bid capacity");
        assertEq(gusd.balanceOf(ledger), ledgerBefore + issFee, "issuance fee to ledger");
        assertEq(hook.totalHookFeesGusd(), 0, "no hook fee on the genesis fallback");
        assertEq(gusd.balanceOf(address(router)), 0, "router empty");
        assertEq(gusd.balanceOf(alice), aliceGusdBefore - paid, "alice spent the quote");
    }

    // ------------------------------------------------------------- pool BUY

    /// BUY filled by the merged book (native + POL + backstop), gUSD-funded;
    /// change refunded; the executable quote anchors execution exactly.
    function test_buy_viaPool_gusdPayment() public {
        uint256 gpuOut = 1e12;
        GpuQuoter.QuoteResult memory q = gq.quoteBuyExactOut(_canonicalKey(), gpuOut);
        assertEq(q.gpuOut, gpuOut);
        uint256 aliceGusdBefore = gusd.balanceOf(alice);

        vm.prank(alice);
        uint256 paid = router.buy(
            GpuRouter.BuyParams({
                gpuId: GPU_ID, gpuOut: gpuOut, payment: address(gusd), maxPaid: q.gusdIn,
                deadline: 0, sqrtLimitX96: 0, recipient: alice
            })
        );

        assertEq(paid, q.gusdIn, "quote == execution");
        assertEq(gpu.balanceOf(alice), gpuOut, "exact GPU out");
        assertEq(gusd.balanceOf(alice), aliceGusdBefore - paid, "alice paid net (change refunded)");
        assertEq(gusd.balanceOf(address(router)), 0, "router empty");
        assertEq(gpu.balanceOf(address(router)), 0, "router holds no GPU");
    }

    /// BUY funded with USDC: internal mint; change still refunds as gUSD.
    function test_buy_viaPool_usdcPayment() public {
        uint256 gpuOut = 1e12;
        uint256 aliceUsdcBefore = underlying.balanceOf(alice);
        uint256 aliceGusdBefore = gusd.balanceOf(alice);

        vm.prank(alice);
        uint256 paid = router.buy(
            GpuRouter.BuyParams({
                gpuId: GPU_ID, gpuOut: gpuOut, payment: address(underlying), maxPaid: 2_000_000e6,
                deadline: 0, sqrtLimitX96: 0, recipient: alice
            })
        );

        assertEq(underlying.balanceOf(alice), aliceUsdcBefore - 2_000_000e6, "USDC pulled = maxPaid");
        assertEq(gpu.balanceOf(alice), gpuOut, "exact GPU out");
        assertGt(gusd.balanceOf(alice) - aliceGusdBefore, 0, "gUSD change refunded");
        assertTrue(paid <= 2_000_000e6);
        assertEq(gusd.balanceOf(address(router)), 0);
    }

    /// Mixed BUY: the hook fills native first, then the in-swap issuance
    /// backstop capitalizes the vault — principal tracks the issued base
    /// exactly once, and the ledger receives the issuance + hook fees.
    function test_buy_mixedLegs() public {
        uint256 gpuOut = 1e12;
        uint256 issuedBefore = issuance.gpuConfig(GPU_ID).totalIssued;
        uint256 principalBefore = pol.principalContributed(GPU_ID);
        uint256 ledgerBefore = gusd.balanceOf(ledger);
        uint256 hookFeesBefore = hook.totalHookFeesGusd();

        vm.prank(alice);
        uint256 paid = router.buy(
            GpuRouter.BuyParams({
                gpuId: GPU_ID, gpuOut: gpuOut, payment: address(gusd), maxPaid: 2_000_000e6,
                deadline: 0, sqrtLimitX96: 0, recipient: alice
            })
        );

        assertEq(gpu.balanceOf(alice), gpuOut, "delivered");
        assertTrue(paid > 0 && paid <= 2_000_000e6);
        uint256 issuedDelta = issuance.gpuConfig(GPU_ID).totalIssued - issuedBefore;
        uint256 base = Math.mulDiv(issuedDelta, 25_000, issuance.compositionDivisor(), Math.Rounding.Ceil);
        assertEq(pol.principalContributed(GPU_ID) - principalBefore, base, "principal == backstop base");
        uint256 ifee = issuedDelta > 0 ? Math.mulDiv(base, 50, 10_000, Math.Rounding.Ceil) : 0;
        assertEq(
            gusd.balanceOf(ledger) - ledgerBefore, ifee + (hook.totalHookFeesGusd() - hookFeesBefore),
            "ledger = issuance fee + hook fee"
        );
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
                gpuId: GPU_ID, gpuOut: 1e12, payment: address(gusd), maxPaid: 1,
                deadline: 0, sqrtLimitX96: 0, recipient: alice
            })
        );
    }

    /// Elastic capacity: a BUY far beyond the native book no longer reverts —
    /// the in-swap issuance backstop mints the tail (the router settles the
    /// full budget first, so the hook's in-lock takes are physically backed).
    function test_buy_backstopFillsHugeDemand() public {
        uint256 issuedBefore = issuance.gpuConfig(GPU_ID).totalIssued;
        vm.prank(alice);
        uint256 paid = router.buy(
            GpuRouter.BuyParams({
                gpuId: GPU_ID, gpuOut: 100e18, payment: address(gusd), maxPaid: 10_000_000e6,
                deadline: 0, sqrtLimitX96: 0, recipient: alice
            })
        );
        assertEq(gpu.balanceOf(alice), 100e18, "full demand filled");
        assertGt(issuance.gpuConfig(GPU_ID).totalIssued - issuedBefore, 0, "backstop participated");
        assertGt(paid, 0);
        assertEq(gusd.balanceOf(address(router)), 0);
    }

    /// Stale oracle: the hook is inert — native-only BUY still works, no
    /// POL fills, no backstop, no fees.
    function test_buy_staleOracle_nativeOnly() public {
        vm.warp(block.timestamp + 30 days);
        uint256 hookFees0 = hook.totalHookFeesGusd();
        uint256 polFees0 = hook.totalPolFeesGusd();
        uint256 principal0 = pol.principalContributed(GPU_ID);
        uint256 issued0 = issuance.gpuConfig(GPU_ID).totalIssued;
        uint256 aliceGpuBefore = gpu.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = router.buy(
            GpuRouter.BuyParams({
                gpuId: GPU_ID, gpuOut: 1e12, payment: address(gusd), maxPaid: 2_000_000e6,
                deadline: 0, sqrtLimitX96: 0, recipient: alice
            })
        );
        assertGt(paid, 0, "native-only buy works");
        assertEq(gpu.balanceOf(alice) - aliceGpuBefore, 1e12);
        assertEq(hook.totalHookFeesGusd(), hookFees0, "no hook fees when stale");
        assertEq(hook.totalPolFeesGusd(), polFees0, "no POL fills when stale");
        assertEq(pol.principalContributed(GPU_ID), principal0, "no backstop when stale");
        assertEq(issuance.gpuConfig(GPU_ID).totalIssued, issued0, "no in-swap issuance when stale");
    }

    function test_buy_paramValidation() public {
        vm.startPrank(alice);
        vm.expectRevert(GpuRouter.ZeroGpuOut.selector);
        router.buy(
            GpuRouter.BuyParams({
                gpuId: GPU_ID, gpuOut: 0, payment: address(gusd), maxPaid: 100,
                deadline: 0, sqrtLimitX96: 0, recipient: alice
            })
        );
        vm.expectRevert(GpuRouter.UnsupportedPayment.selector);
        router.buy(
            GpuRouter.BuyParams({
                gpuId: GPU_ID, gpuOut: 10, payment: address(0xBEEF), maxPaid: 100,
                deadline: 0, sqrtLimitX96: 0, recipient: alice
            })
        );
        vm.expectRevert(GpuRouter.UnknownGpu.selector);
        router.buy(
            GpuRouter.BuyParams({
                gpuId: bytes32("NOPE"), gpuOut: 10, payment: address(gusd), maxPaid: 100,
                deadline: 0, sqrtLimitX96: 0, recipient: alice
            })
        );
        vm.stopPrank();
    }

    // ---------------------------------------------------------- buyExactIn

    /// Full fill: the caller spends exactly gusdMaxIn; the hook fee on this
    /// shape is charged in gUSD out of the absorbed budget (counter moves).
    function test_buyExactIn_fullFill() public {
        uint256 gusdMaxIn = 1e9;
        uint256 minGpuOut = 9e8;
        uint256 hookFees0 = hook.totalHookFeesGusd();
        uint256 aliceGusdBefore = gusd.balanceOf(alice);

        vm.prank(alice);
        uint256 gpuOut = router.buyExactIn(GPU_ID, gusdMaxIn, minGpuOut, 0, 0, alice);

        assertGt(gpuOut, minGpuOut, "full fill");
        assertEq(gusd.balanceOf(alice), aliceGusdBefore - gusdMaxIn, "paid exactly gusdMaxIn");
        assertGt(hook.totalHookFeesGusd(), hookFees0, "exactIn buy fee lands in gUSD");
        assertEq(gusd.balanceOf(address(router)), 0);
        assertEq(gpu.balanceOf(address(router)), 0);
    }

    function test_buyExactIn_slippage() public {
        vm.prank(alice);
        vm.expectRevert(GpuRouter.Slippage.selector);
        router.buyExactIn(GPU_ID, 1e9, 1e21, 0, 0, alice); // minGpuOut unreachable
    }

    function test_buyExactIn_requiresCanonicalPool() public {
        vm.prank(alice);
        vm.expectRevert(GpuRouter.NotCanonicalPool.selector);
        router.buyExactIn(GENESIS_ID, 1e9, 0, 0, 0, alice);
    }

    // --------------------------------------------------------------- SELL

    /// Scenario 7: SELL via the merged book, gUSD payout. The hook fee on
    /// sells is gUSD-denominated on the net POL spend (native legs are fee-
    /// free for the hook — LPs earn their own fee).
    function test_sell_gusdPayout() public {
        uint256 gpuIn = 1e12;
        uint256 polNotional0 = hook.totalPolNotionalGusd();
        uint256 polFees0 = hook.totalPolFeesGusd();
        uint256 hookFees0 = hook.totalHookFeesGusd();
        uint256 bobGusdBefore = gusd.balanceOf(bob);
        uint256 bobGpuBefore = gpu.balanceOf(bob);

        vm.prank(bob);
        uint256 out = router.sell(
            GpuRouter.SellParams({
                gpuId: GPU_ID, gpuIn: gpuIn, payout: address(gusd), minOut: 1, deadline: 0, sqrtLimitX96: 0,
                recipient: bob
            })
        );

        assertGt(out, 0, "received gUSD");
        assertEq(gusd.balanceOf(bob), bobGusdBefore + out);
        assertEq(gpu.balanceOf(bob), bobGpuBefore - gpuIn, "GPU pulled");
        uint256 polSpend = hook.totalPolNotionalGusd() - polNotional0;
        uint256 polFee = hook.totalPolFeesGusd() - polFees0;
        if (polSpend > 0) {
            assertEq(hook.totalHookFeesGusd() - hookFees0, _hookFeeOf(polSpend - polFee), "hook fee on net POL spend");
        }
        assertEq(gusd.balanceOf(address(router)), 0);
        assertEq(gpu.balanceOf(address(router)), 0);
    }

    /// SELL with USDC payout: the redeem fee lands in the ledger; out =
    /// gusdNet net of the fee (the router grosses minOut up internally).
    function test_sell_usdcPayout_redeemFeeGrossUp() public {
        gusd.setFees(0, 100); // 1% redeem fee
        uint256 gpuIn = 1e13;
        uint256 minOut = 5; // USDC units; tiny trade on purpose
        uint256 ledgerBefore = gusd.balanceOf(ledger);
        uint256 supplyBefore = gusd.totalSupply();
        uint256 bobUsdcBefore = underlying.balanceOf(bob);

        vm.prank(bob);
        uint256 out = router.sell(
            GpuRouter.SellParams({
                gpuId: GPU_ID, gpuIn: gpuIn, payout: address(underlying), minOut: minOut, deadline: 0, sqrtLimitX96: 0,
                recipient: bob
            })
        );

        assertGe(out, minOut, "payout bound holds after redeem fee");
        assertEq(underlying.balanceOf(bob), bobUsdcBefore + out);
        // exact gusdNet from supply accounting: dSupply = -gusdNet + redeemFee
        uint256 redeemFee = gusd.balanceOf(ledger) - ledgerBefore;
        uint256 gusdNet = redeemFee + (supplyBefore - gusd.totalSupply());
        assertGt(redeemFee, 0, "redeem fee to ledger");
        assertEq(out, gusdNet - redeemFee, "out = gusdNet net of redeem fee");
        assertEq(gusd.balanceOf(address(router)), 0);
    }

    /// Empty pool (initialized, zero liquidity, zero bid inventory): SELL
    /// fails closed — the honest closed market.
    function test_sell_emptyPoolRevertsCleanly() public {
        manager.initialize(_canonicalKeyFor(GENESIS_ID), SQRT_PRICE_1_1); // no LP
        GPUToken genGpu = GPUToken(issuance.tokenOf(GENESIS_ID));
        _issueGpuTo(GENESIS_ID, bob, 10e18);
        vm.startPrank(bob);
        genGpu.approve(address(router), type(uint256).max);
        vm.stopPrank();
        // the genesis issuance principal capitalizes the vault bid even on a
        // book with zero liquidity — the honest closed-market lever is the
        // POL cap, and the hook revert surfaces ERC-7751-wrapped via unlock
        hook.setPolCaps(0, 0);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeSwap.selector,
                abi.encodePacked(GPUHook.InsufficientMarketCapacity.selector),
                abi.encodePacked(Hooks.HookCallFailed.selector)
            )
        );
        router.sell(
            GpuRouter.SellParams({
                gpuId: GENESIS_ID, gpuIn: 1e12, payout: address(gusd), minOut: 1, deadline: 0, sqrtLimitX96: 0,
                recipient: bob
            })
        );
    }

    /// SELL within the merged book: the full input is consumed; the vault's
    /// bid inventory pays the beyond-edge tail and acquires GPU at the bid.
    function test_sell_fullConsumesInput() public {
        uint256 gpuIn = 100e18;
        uint256 bid0 = pol.bidInventoryGusd(GPU_ID);
        uint256 ask0 = pol.askInventoryGpu(GPU_ID);
        uint256 bobGpuBefore = gpu.balanceOf(bob);

        vm.prank(bob);
        uint256 out = router.sell(
            GpuRouter.SellParams({
                gpuId: GPU_ID, gpuIn: gpuIn, payout: address(gusd), minOut: 1, deadline: 0, sqrtLimitX96: 0,
                recipient: bob
            })
        );

        assertEq(bobGpuBefore - gpu.balanceOf(bob), gpuIn, "full input consumed");
        assertGt(out, 0);
        assertLt(pol.bidInventoryGusd(GPU_ID), bid0, "bid inventory spent");
        assertGt(pol.askInventoryGpu(GPU_ID), ask0, "vault acquired GPU at the bid");
        assertEq(gusd.balanceOf(address(router)), 0);
        assertEq(gpu.balanceOf(address(router)), 0);
    }

    function test_sell_slippage() public {
        vm.prank(bob);
        vm.expectRevert(GpuRouter.Slippage.selector);
        router.sell(
            GpuRouter.SellParams({
                gpuId: GPU_ID, gpuIn: 1e12, payout: address(gusd), minOut: 5e13, deadline: 0, sqrtLimitX96: 0,
                recipient: bob
            })
        );
    }

    function test_sell_requiresCanonicalPool() public {
        vm.prank(bob);
        vm.expectRevert(GpuRouter.NotCanonicalPool.selector);
        router.sell(
            GpuRouter.SellParams({
                gpuId: GENESIS_ID, gpuIn: 1e12, payout: address(gusd), minOut: 1, deadline: 0, sqrtLimitX96: 0,
                recipient: bob
            })
        );
    }

    // ------------------------------------------------------- LP fee sanity

    /// LP fee accrues to the pool independently of the hook: native legs pay
    /// LPs even when the hook's own counters stay flat.
    function test_buy_lpFeeAndHookFeeIndependent() public {
        (,, uint24 packedProtocolFee, uint24 lpFee) = stateView.getSlot0(_canonicalKey().toId());
        assertEq(packedProtocolFee, 0);
        assertEq(lpFee, POOL_FEE);

        (uint256 g0, uint256 g1) = stateView.getFeeGrowthGlobals(_canonicalKey().toId());
        vm.prank(alice);
        router.buy(
            GpuRouter.BuyParams({
                gpuId: GPU_ID, gpuOut: 1e12, payment: address(gusd), maxPaid: 2_000_000e6,
                deadline: 0, sqrtLimitX96: 0, recipient: alice
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
