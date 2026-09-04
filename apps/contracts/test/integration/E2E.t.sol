// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateView} from "@uniswap/v4-periphery/lens/StateView.sol";
import {PositionManager} from "@uniswap/v4-periphery/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/PositionDescriptor.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/interfaces/IV4Quoter.sol";
import {V4Quoter} from "@uniswap/v4-periphery/lens/V4Quoter.sol";
import {IWETH9} from "@uniswap/v4-periphery/interfaces/external/IWETH9.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";
import {Actions} from "@uniswap/v4-periphery/libraries/Actions.sol";
import {Planner, Plan} from "v4-periphery-test/shared/Planner.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {WETH} from "solmate/src/tokens/WETH.sol";
import {GUSD} from "../../src/GUSD.sol";
import {GPUIssuance} from "../../src/GPUIssuance.sol";
import {GPUToken} from "../../src/GPUToken.sol";
import {RevenueLedger} from "../../src/RevenueLedger.sol";
import {sgUSD} from "../../src/sgUSD.sol";
import {GPUHook} from "../../src/hooks/GPUHook.sol";
import {GpuRouter} from "../../src/GpuRouter.sol";
import {MockGPUPriceOracle} from "../../src/oracle/MockGPUPriceOracle.sol";
import {IGPUIssuance} from "../../src/interfaces/IGPUIssuance.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HookMiner} from "v4-periphery-test/shared/HookMiner.sol";

/// @notice End-to-end product chain on a deploy-mirror rig: genesis BUY ->
///         external LP (PositionManager/Permit2) -> pool BUY -> mixed BUY ->
///         SELL -> oracle reprice -> harvest -> distribute -> sgUSD accrual,
///         plus failure shapes (oversized BUY/SELL with impact-capped limits,
///         stale oracle). One ordering: currency ordering is covered
///         exhaustively in the unit + LP suites.
contract E2ETest is Test, DeployPermit2 {
    using PoolIdLibrary for PoolKey;

    MockERC20 internal usdc;
    GUSD internal gusd;
    MockGPUPriceOracle internal oracle;
    GPUIssuance internal issuance;
    GPUHook internal hook;
    GpuRouter internal router;
    RevenueLedger internal ledger;
    sgUSD internal sg;
    StateView internal stateView;
    PositionManager internal posm;
    IV4Quoter internal quoter;
    IAllowanceTransfer internal permit2;
    IPoolManager internal manager;
    GPUToken internal gpu;
    PoolKey internal key;
    PoolId internal poolId;
    bool internal gIsC0;

    bytes32 internal constant H100 = bytes32(bytes("H100_SXM_80GB"));
    uint24 internal constant POOL_FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    uint160 constant HOOK_FLAGS = uint160(
        Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    address internal alice = makeAddr("alice"); // buyer + LP
    address internal bob = makeAddr("bob"); // buyer + seller
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        oracle = new MockGPUPriceOracle(address(this));
        manager = IPoolManager(address(new PoolManager(address(this))));
        stateView = new StateView(manager);
        // precompiled canonical Permit2 bytecode (permit2 pins solc 0.8.17)
        permit2 = IAllowanceTransfer(deployPermit2());
        WETH weth = new WETH();
        posm = new PositionManager(
            manager, permit2, 100_000, new PositionDescriptor(manager, address(weth), "ETH"), IWETH9(address(weth))
        );
        quoter = new V4Quoter(manager);

        gusd = new GUSD(IERC20(address(usdc)), address(this));
        sg = new sgUSD(IERC20(address(gusd)), address(this));
        ledger = new RevenueLedger(IERC20(address(gusd)), address(this));
        issuance = new GPUIssuance(IERC20(address(gusd)), oracle, address(ledger), address(this));

        bytes memory ctorArgs = abi.encode(manager, address(gusd), issuance, address(ledger), address(this));
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), HOOK_FLAGS, type(GPUHook).creationCode, ctorArgs);
        new GPUHook{salt: salt}(manager, address(gusd), issuance, address(ledger), address(this));
        hook = GPUHook(hookAddr);

        router = new GpuRouter(manager, gusd, issuance, hook, IERC20(address(usdc)));

        gusd.setRevenueSink(address(ledger));
        gusd.setFees(0, 0);
        ledger.setVault(address(sg));
        ledger.setTreasury(treasury);
        ledger.setSplit(5_000);
        hook.setHookFeeBps(50);
        // seed the sgUSD vault: 1 gUSD in, 1 share out (one-way gate)
        usdc.mint(address(this), 1e6);
        usdc.approve(address(gusd), 1e6);
        gusd.mintUSDC(1e6, address(this));
        gusd.approve(address(sg), 1e6);
        sg.seed(1e6);

        issuance.createGpu(H100, "H100 SXM 80GB GPU-hour", "H100", 50, POOL_FEE, TICK_SPACING);
        issuance.setIssuanceEnabled(H100, true);
        oracle.setPrice(H100, 25_000, block.timestamp); // $2.50/GPU-hour
        gpu = GPUToken(issuance.tokenOf(H100));

        gIsC0 = address(gusd) < address(gpu);
        key.currency0 = gIsC0 ? Currency.wrap(address(gusd)) : Currency.wrap(address(gpu));
        key.currency1 = gIsC0 ? Currency.wrap(address(gpu)) : Currency.wrap(address(gusd));
        IGPUIssuance.PoolParams memory pp = issuance.poolParamsOf(H100);
        key.fee = pp.fee;
        key.tickSpacing = pp.tickSpacing;
        key.hooks = hook;
        int24 initTick = gIsC0 ? int24(267_160) : int24(-267_160);
        manager.initialize(key, TickMath.getSqrtPriceAtTick(initTick));
        poolId = key.toId();
        require(hook.poolGpuId(poolId) == H100, "pool not registered");

        // fund + approvals
        usdc.mint(alice, 1_000_000e6);
        usdc.mint(bob, 1_000_000e6);
        vm.startPrank(alice);
        usdc.approve(address(gusd), type(uint256).max);
        gusd.mintUSDC(10_000e6, alice);
        gusd.approve(address(router), type(uint256).max);
        usdc.approve(address(router), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(bob);
        usdc.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------- helpers

    function _approvePosm(address who) internal {
        vm.startPrank(who);
        IERC20(address(gusd)).approve(address(permit2), type(uint256).max);
        IERC20(address(gpu)).approve(address(permit2), type(uint256).max);
        permit2.approve(address(gusd), address(posm), type(uint160).max, type(uint48).max);
        permit2.approve(address(gpu), address(posm), type(uint160).max, type(uint48).max);
        vm.stopPrank();
    }

    /// @notice alice LPs the canonical pool full-range via the PM:
    ///         50 H100 + 125 gUSD at the 2.5 gUSD/GPU price.
    function _lpAlice() internal returns (uint256 tokenId) {
        _approvePosm(alice);
        Plan memory plan = Planner.init();
        plan.add(
            Actions.MINT_POSITION,
            abi.encode(key, -887220, 887220, 7.9e13, type(uint128).max, type(uint128).max, alice, "")
        );
        bytes memory calls = plan.finalizeModifyLiquidityWithClose(key);
        tokenId = posm.nextTokenId();
        vm.prank(alice);
        posm.modifyLiquidities(calls, block.timestamp + 1);
        return tokenId;
    }

    /// @notice alice buys GPU via issuance directly (tests that skip the
    ///         genesis-BUY flow but still need her to hold GPU to LP).
    function _issueGpuTo(address who, uint256 amount) internal {
        vm.startPrank(who);
        gusd.approve(address(issuance), type(uint256).max);
        issuance.issue(H100, amount, who);
        vm.stopPrank();
    }

    function _buyGusd(address who, uint256 usdcAmount) internal {
        vm.startPrank(who);
        IERC20(address(usdc)).approve(address(gusd), type(uint256).max);
        gusd.mintUSDC(usdcAmount, who);
        vm.stopPrank();
    }

    function _buyGpu(
        uint256 gpuOut,
        uint256 poolGpuOut,
        uint256 issueGpuOut,
        address payment,
        uint256 maxPaid,
        address to
    ) internal returns (uint256 paid) {
        GpuRouter.BuyParams memory p = GpuRouter.BuyParams({
            gpuId: H100,
            gpuOut: gpuOut,
            poolGpuOut: poolGpuOut,
            issueGpuOut: issueGpuOut,
            payment: payment,
            maxPaid: maxPaid,
            sqrtLimitX96: 0,
            recipient: to
        });
        return router.buy(p);
    }

    function _sellGpu(address who, uint256 gpuIn, address payout, uint256 minOut, address to)
        internal
        returns (uint256 out)
    {
        GpuRouter.SellParams memory p = GpuRouter.SellParams({
            gpuId: H100, gpuIn: gpuIn, payout: payout, minOut: minOut, sqrtLimitX96: 0, recipient: to
        });
        vm.startPrank(who);
        IERC20(address(gpu)).approve(address(router), type(uint256).max);
        out = router.sell(p);
        vm.stopPrank();
    }

    // -------------------------------------------------------------- tests

    /// @notice The whole M2 product chain, one test: every user flow is a
    ///         single router call; protocol revenue flows to sgUSD.
    function test_fullProductChain() public {
        // 1) genesis BUY: zero circulating supply, 100% issuance, no pool leg
        uint256 ledger0 = gusd.balanceOf(address(ledger));
        vm.prank(alice);
        uint256 paid1 = _buyGpu(100e18, 0, 100e18, address(gusd), 300e6, alice);
        assertEq(paid1, 251_250_000, "genesis cost 100x2.5x1.005");
        assertEq(gpu.balanceOf(alice), 100e18);
        assertEq(issuance.gpuReserve(H100), 250_000_000, "reserve");
        assertEq(hook.totalTradingFeesAccrued(), 0, "no hook fee on genesis");
        assertEq(gusd.balanceOf(address(ledger)) - ledger0, 1_250_000, "issuance fee");
        assertEq(gusd.balanceOf(address(router)), 0, "router empty");

        // 2) external LP via PositionManager + Permit2
        uint256 tokenId = _lpAlice();
        assertGt(stateView.getLiquidity(poolId), 0, "pool liquid");
        assertEq(posm.ownerOf(tokenId), alice);

        // 3) BUY 2 H100 via pool, USDC payment; quote == execution
        (uint256 quotedIn,) = quoter.quoteExactOutputSingle(
            IV4Quoter.QuoteExactSingleParams({poolKey: key, zeroForOne: gIsC0, exactAmount: 2e18, hookData: ""})
        );
        uint256 hookFees = hook.totalTradingFeesAccrued();
        vm.prank(bob);
        uint256 paid3 = _buyGpu(2e18, 2e18, 0, address(usdc), quotedIn, bob);
        assertEq(paid3, quotedIn, "quote == execution");
        assertEq(gpu.balanceOf(bob), 2e18);
        uint256 hookFeeBuy = hook.totalTradingFeesAccrued() - hookFees;
        assertGt(hookFeeBuy, 0, "hook fee on buy");
        // LP fee accrued on the gUSD (input) side; hook fee is separate
        (uint256 fg0, uint256 fg1) = stateView.getFeeGrowthGlobals(poolId);
        uint256 lpgusd = gIsC0 ? fg0 : fg1;
        assertGt(lpgusd, 0, "LP gUSD fee accrued");

        // 4) mixed BUY 5 = 3 pool + 2 issuance
        uint256 reserve4 = issuance.gpuReserve(H100);
        uint256 ledger4 = gusd.balanceOf(address(ledger));
        vm.prank(bob);
        _buyGpu(5e18, 3e18, 2e18, address(usdc), 20e6, bob);
        assertEq(gpu.balanceOf(bob), 7e18);
        assertEq(issuance.gpuReserve(H100) - reserve4, 5_000_000, "issuance reserve 2x2.5");
        assertEq(gusd.balanceOf(address(ledger)) - ledger4, 25_000, "issuance fee 0.5% of 5");

        // 5) SELL 1 H100 -> USDC: pure secondary, oracle untouched
        uint256 bobUsdc = usdc.balanceOf(bob);
        uint256 out5 = _sellGpu(bob, 1e18, address(usdc), 2e6, bob);
        assertGe(out5, 2e6, "sell payout");
        assertEq(usdc.balanceOf(bob) - bobUsdc, out5, "sell payout delivered");
        assertEq(gpu.balanceOf(bob), 6e18);
        assertGt(hook.totalTradingFeesAccrued(), hookFees + hookFeeBuy, "hook fee on sell");
        assertEq(issuance.gpuReserve(H100), 255_000_000, "reserves untouched by trades");

        // 6) harvest + distribute: hook fees -> ledger -> sgUSD vault/treasury
        vm.prank(address(this));
        hook.harvestTradingFees(poolId, 0);
        assertEq(hook.pendingTradingFees(poolId), 0);
        assertGt(hook.totalTradingFeesHarvested(), 0);
        uint256 sgAssetsBefore = gusd.balanceOf(address(sg));
        uint256 treasuryBefore = gusd.balanceOf(treasury);
        ledger.distribute();
        assertEq(gusd.balanceOf(address(ledger)), 0, "ledger drained");
        assertGt(gusd.balanceOf(address(sg)), sgAssetsBefore, "vault funded");
        assertGt(gusd.balanceOf(treasury), treasuryBefore, "treasury funded");

        // Definition-of-Success
        assertEq(usdc.balanceOf(address(gusd)), gusd.totalSupply(), "reserve == supply");
        assertEq(gusd.balanceOf(address(router)), 0, "router holds no gUSD");
        assertEq(gpu.balanceOf(address(router)), 0, "router holds no GPU");
        assertEq(gusd.balanceOf(address(hook)), 0, "hook drained");
        assertEq(issuance.gpuReserve(H100), 255_000_000, "issuance reserve final");
        assertGt(sg.convertToAssets(1e6), 1e6, "sgUSD share price up");
        assertEq(posm.balanceOf(address(router)), 0, "router holds no NFTs");
    }

    /// @notice Oracle reprice: next issuance reprices; pool + reserves do not.
    function test_oracleReprice() public {
        (uint256 base0,,) = issuance.quoteIssue(H100, 1e18);
        assertEq(base0, 2_500_000);
        (, int24 tickBefore,,) = stateView.getSlot0(poolId);
        uint256 reserve = issuance.gpuReserve(H100);

        oracle.setPrice(H100, 30_000, block.timestamp); // $3.00

        (uint256 base1,,) = issuance.quoteIssue(H100, 1e18);
        assertEq(base1, 3_000_000, "issuance repriced");
        (, int24 tickAfter,,) = stateView.getSlot0(poolId);
        assertEq(tickBefore, tickAfter, "pool price moved?");
        assertEq(issuance.gpuReserve(H100), reserve, "reserve moved?");
    }

    /// @notice Oversized pool BUY with an impact-capped sqrtLimit: the pool
    ///         cannot fill the request -> router PoolShortfall, state rolls
    ///         back, funds intact. (With a wide limit the swap instead drains
    ///         the pool to MIN_SQRT and the hook's inside-swap fee take reverts
    ///         on the PoolManager's physical balance first — the offchain
    ///         quoting layer always caps impact, so PoolShortfall is the
    ///         product surface.)
    function test_oversizedBuy_poolShortfall() public {
        _issueGpuTo(alice, 1_100e18);
        _lpAlice();
        _buyGusd(bob, 1_000_000e6);
        vm.prank(bob);
        gusd.approve(address(router), type(uint256).max);
        // cap impact at one tick-spacing step: the pool delivers far less
        // than the requested 1000 GPU, so the all-or-nothing leg reverts
        int24 curTick = gIsC0 ? int24(267_160) : int24(-267_160);
        int24 limitTick = gIsC0 ? curTick - TICK_SPACING : curTick + TICK_SPACING;
        uint160 sqrtLimit = TickMath.getSqrtPriceAtTick(limitTick);
        GpuRouter.BuyParams memory p = GpuRouter.BuyParams({
            gpuId: H100,
            gpuOut: 1_000e18,
            poolGpuOut: 1_000e18,
            issueGpuOut: 0,
            payment: address(gusd),
            maxPaid: 1_000_000e6,
            sqrtLimitX96: sqrtLimit,
            recipient: bob
        });
        vm.prank(bob);
        vm.expectRevert(GpuRouter.PoolShortfall.selector);
        router.buy(p);
        assertEq(gpu.balanceOf(bob), 0, "no tokens");
        assertEq(gusd.balanceOf(bob), 1_000_000e6, "funds intact");
    }

    /// @notice Oversized SELL with an unreachable minOut reverts cleanly.
    function test_oversizedSell_slippage() public {
        _issueGpuTo(alice, 1_100e18);
        _lpAlice();
        // bob holds 1000 H100 (issued), pool yields ~119 gUSD for all of it
        vm.startPrank(alice);
        gusd.approve(address(issuance), type(uint256).max);
        issuance.issue(H100, 1_000e18, bob);
        vm.stopPrank();
        vm.startPrank(bob);
        IERC20(address(gpu)).approve(address(router), type(uint256).max);
        vm.stopPrank();
        GpuRouter.SellParams memory p = GpuRouter.SellParams({
            gpuId: H100,
            gpuIn: 1_000e18,
            payout: address(gusd),
            minOut: 200e6, // pool can only ever yield ~119 gUSD
            sqrtLimitX96: 0,
            recipient: bob
        });
        vm.prank(bob);
        vm.expectRevert(GpuRouter.Slippage.selector);
        router.sell(p);
        assertEq(gpu.balanceOf(bob), 1_000e18, "tokens intact");
    }

    /// @notice buyExactIn full fill: quote == execution (hook-inclusive), the
    ///         caller spends exactly gusdMaxIn, the router stays dust-free.
    ///         (All-or-nothing PartialFillNotSupported is covered exhaustively
    ///         in the unit rigs' narrow bands; a full-range pool always fully
    ///         consumes exact-in amounts at practical sizes.)
    function test_buyExactIn_quoteParity() public {
        _issueGpuTo(alice, 1_100e18);
        _lpAlice();
        _buyGusd(bob, 1_000_000e6);
        vm.startPrank(bob);
        gusd.approve(address(router), type(uint256).max);
        vm.stopPrank();

        (uint256 quotedOut,) = quoter.quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({poolKey: key, zeroForOne: gIsC0, exactAmount: 10e6, hookData: ""})
        );
        uint256 hookFees = hook.totalTradingFeesAccrued();
        vm.prank(bob);
        uint256 gpuOut = router.buyExactIn(H100, 10e6, quotedOut, 0, bob);
        assertEq(gpuOut, quotedOut, "quote == execution");
        assertGt(gpuOut, 0);
        assertGt(hook.totalTradingFeesAccrued(), hookFees, "hook fee accrued");
        assertEq(gusd.balanceOf(bob), 1_000_000e6 - 10e6, "exact spend");
        assertEq(gusd.balanceOf(address(router)), 0, "router dust-free");
    }

    /// @notice Stale oracle: issuance legs revert; pool-only BUY + SELL work.
    function test_staleOracle_poolFlowsStillWork() public {
        _issueGpuTo(alice, 1_100e18);
        _lpAlice();
        vm.warp(block.timestamp + 26 hours); // staleness window: 25 hours

        // mixed BUY reverts on the issuance leg
        vm.prank(alice);
        vm.expectRevert(GPUIssuance.OracleStale.selector);
        _buyGpu(3e18, 1e18, 2e18, address(gusd), 100e6, alice);

        // pool-only BUY succeeds
        vm.prank(alice);
        uint256 paid = _buyGpu(1e18, 1e18, 0, address(gusd), 100e6, alice);
        assertGt(paid, 0);
        assertGt(hook.totalTradingFeesAccrued(), 0);

        // SELL succeeds (never reads the oracle)
        uint256 out = _sellGpu(alice, 5e17, address(gusd), 1, alice);
        assertGt(out, 0);
    }
}
