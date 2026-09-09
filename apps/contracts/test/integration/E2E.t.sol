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
import {GpuQuoter} from "../../src/lens/GpuQuoter.sol";
import {MockGPUPriceOracle} from "../../src/oracle/MockGPUPriceOracle.sol";
import {IGPUIssuance} from "../../src/interfaces/IGPUIssuance.sol";
import {GPUMarketLiquidity} from "../../src/GPUMarketLiquidity.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HookMiner} from "v4-periphery-test/shared/HookMiner.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";

/// @notice End-to-end product chain on a deploy-mirror rig: genesis BUY
///         (cold pool: 100% in-swap issuance backstop) -> external LP
///         (PositionManager/Permit2) -> pool BUY (quote == execution) ->
///         mixed BUY -> SELL -> distribute -> sgUSD accrual, plus failure
///         shapes (oversized BUY filled by the backstop, honest finite sell
///         liquidity, stale-oracle degradation). One ordering: currency
///         ordering is covered exhaustively in the unit + LP suites.
contract E2ETest is Test, DeployPermit2 {
    using PoolIdLibrary for PoolKey;

    MockERC20 internal underlying;
    GUSD internal gusd;
    MockGPUPriceOracle internal oracle;
    GPUIssuance internal issuance;
    GPUHook internal hook;
    GpuRouter internal router;
    RevenueLedger internal ledger;
    sgUSD internal sg;
    StateView internal stateView;
    PositionManager internal posm;
    GpuQuoter internal gq;
    IAllowanceTransfer internal permit2;
    IPoolManager internal manager;
    GPUToken internal gpu;
    PoolKey internal key;
    PoolId internal poolId;
    bool internal gIsC0;
    GPUMarketLiquidity internal pol;

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
        underlying = new MockERC20("USD Coin", "USDC", 6);
        oracle = new MockGPUPriceOracle(address(this));
        manager = IPoolManager(address(new PoolManager(address(this))));
        stateView = new StateView(manager);
        // precompiled canonical Permit2 bytecode (permit2 pins solc 0.8.17)
        permit2 = IAllowanceTransfer(deployPermit2());
        WETH weth = new WETH();
        posm = new PositionManager(
            manager, permit2, 100_000, new PositionDescriptor(manager, address(weth), "ETH"), IWETH9(address(weth))
        );

        gusd = new GUSD(IERC20(address(underlying)), address(this));
        sg = new sgUSD(IERC20(address(gusd)), address(this));
        ledger = new RevenueLedger(IERC20(address(gusd)), address(this));
        pol = new GPUMarketLiquidity(IERC20(address(gusd)), address(manager), address(this));
        issuance = new GPUIssuance(IERC20(address(gusd)), oracle, address(ledger), address(pol), address(this));

        bytes memory ctorArgs = abi.encode(manager, address(gusd), oracle, issuance, address(ledger), address(this));
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), HOOK_FLAGS, type(GPUHook).creationCode, ctorArgs);
        new GPUHook{salt: salt}(manager, address(gusd), oracle, issuance, address(ledger), address(this));
        hook = GPUHook(hookAddr);

        router = new GpuRouter(manager, gusd, issuance, hook);
        pol.setRefs(address(issuance), address(hook));
        // executable-quote lens: fund the gUSD float (rolled back on every
        // quote revert — floats are reusable across tests)
        gq = new GpuQuoter(manager, address(gusd), issuance, address(this));
        underlying.mint(address(this), 10_000_000e6);
        underlying.approve(address(gusd), type(uint256).max);
        gusd.mint(10_000_000e6, address(this));
        gusd.approve(address(gq), type(uint256).max);
        gq.setGusdFloat(10_000_000e6);

        gusd.setRevenueSink(address(ledger));
        gusd.setFees(0, 0);
        ledger.setVault(address(sg));
        ledger.setTreasury(treasury);
        ledger.setSplit(5_000);
        hook.setHookFeeBps(50);
        // seed the sgUSD vault: 1 gUSD in, 1 share out (one-way gate)
        underlying.mint(address(this), 1e6);
        underlying.approve(address(gusd), 1e6);
        gusd.mint(1e6, address(this));
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
        underlying.mint(alice, 1_000_000e6);
        underlying.mint(bob, 1_000_000e6);
        vm.startPrank(alice);
        underlying.approve(address(gusd), type(uint256).max);
        gusd.mint(10_000e6, alice);
        gusd.approve(address(router), type(uint256).max);
        underlying.approve(address(router), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(bob);
        underlying.approve(address(router), type(uint256).max);
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
        deal(address(underlying), who, usdcAmount); // self-funding: setUp grants only 1M
        vm.startPrank(who);
        IERC20(address(underlying)).approve(address(gusd), type(uint256).max);
        gusd.mint(usdcAmount, who);
        vm.stopPrank();
    }

    function _buyGpu(uint256 gpuOut, address payment, uint256 maxPaid, address to)
        internal
        returns (uint256 paid)
    {
        GpuRouter.BuyParams memory p = GpuRouter.BuyParams({
            gpuId: H100,
            gpuOut: gpuOut,
            payment: payment,
            maxPaid: maxPaid,
            deadline: 0,
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
            gpuId: H100, gpuIn: gpuIn, payout: payout, minOut: minOut, deadline: 0, sqrtLimitX96: 0, recipient: to
        });
        vm.startPrank(who);
        IERC20(address(gpu)).approve(address(router), type(uint256).max);
        out = router.sell(p);
        vm.stopPrank();
    }

    // -------------------------------------------------------------- tests

    /// @notice The C-max product chain, one test: every user flow is a
    ///         single router call; the hook composes native LP flow, POL
    ///         inventory and the in-swap issuance backstop; fee counters
    ///         reconcile to the ledger to the wei.
    function test_fullProductChain() public {
        // 1) genesis BUY: zero circulating supply, cold pool -> 100% in-swap
        //    backstop at oracle + fees; principal capitalizes the vault as
        //    bid capacity immediately
        uint256 ledger0 = gusd.balanceOf(address(ledger));
        uint256 issued0 = issuance.gpuConfig(H100).totalIssued;
        vm.prank(alice);
        uint256 paid1 = _buyGpu(100e18, address(gusd), 300e6, alice);
        vm.stopPrank();
        // charge 100 x 2.5 x 1.005 = 251_250_000 + hook fee 1_256_250
        assertEq(paid1, 252_506_250, "genesis: backstop charge + hook fee");
        assertEq(gpu.balanceOf(alice), 100e18);
        assertEq(pol.principalContributed(H100), 250_000_000, "principal capitalized");
        assertEq(pol.bidInventoryGusd(H100), 250_000_000, "principal is bid capacity");
        assertEq(pol.askInventoryGpu(H100), 0, "no ask inventory yet");
        assertEq(issuance.gpuConfig(H100).totalIssued - issued0, 100e18, "backstop minted");
        assertEq(hook.totalHookFeesGusd(), 1_256_250, "hook fee counter");
        assertEq(hook.totalPolFeesGusd(), 0, "no POL fills on a cold pool");
        assertEq(gusd.balanceOf(address(ledger)) - ledger0, 2_506_250, "issuance + hook fee to ledger");
        assertEq(gusd.balanceOf(address(issuance)), 0, "issuance holds no gUSD");
        assertEq(gusd.balanceOf(address(router)), 0, "router empty");
        assertEq(gusd.balanceOf(address(hook)), 0, "hook holds nothing at rest");

        // 2) external LP via PositionManager + Permit2
        uint256 tokenId = _lpAlice();
        assertGt(stateView.getLiquidity(poolId), 0, "pool liquid");
        assertEq(posm.ownerOf(tokenId), alice);

        // 3) BUY 2 H100 via pool, USDC payment; quote == execution, counters
        //    reconcile against the quoted decomposition
        GpuQuoter.QuoteResult memory q3 = gq.quoteBuyExactOut(key, 2e18);
        assertEq(q3.gpuOut, 2e18);
        assertGt(q3.gusdIn, 0);
        uint256 hookFees3 = hook.totalHookFeesGusd();
        uint256 polFees3 = hook.totalPolFeesGusd();
        uint256 principal3 = pol.principalContributed(H100);
        uint256 issued3 = issuance.gpuConfig(H100).totalIssued;
        vm.startPrank(bob);
        uint256 paid3 = _buyGpu(2e18, address(underlying), q3.gusdIn, bob);
        vm.stopPrank();
        assertEq(paid3, q3.gusdIn, "quote == execution");
        assertEq(gpu.balanceOf(bob), 2e18);
        assertEq(hook.totalHookFeesGusd() - hookFees3, q3.hookFeeGusd, "hook fee counter == quote");
        assertEq(hook.totalPolFeesGusd() - polFees3, q3.polFeeGusd, "POL fee counter == quote");
        assertEq(pol.principalContributed(H100) - principal3, q3.issueBase, "backstop principal == quote");
        assertEq(issuance.gpuConfig(H100).totalIssued - issued3, q3.backstopGpu, "backstop mint == quote");
        // LP fee accrued on the gUSD (input) side of the native leg
        (uint256 fg0, uint256 fg1) = stateView.getFeeGrowthGlobals(poolId);
        assertGt(gIsC0 ? fg0 : fg1, 0, "LP gUSD fee accrued");

        // 4) mixed BUY 5 = native + backstop; the ledger receives the
        //    issuance fee plus the hook fee, exactly
        uint256 ledger4 = gusd.balanceOf(address(ledger));
        uint256 hookFees4 = hook.totalHookFeesGusd();
        uint256 principal4 = pol.principalContributed(H100);
        uint256 issued4 = issuance.gpuConfig(H100).totalIssued; // step-3 buy already minted
        vm.startPrank(bob);
        _buyGpu(5e18, address(underlying), 20e6, bob);
        vm.stopPrank();
        assertEq(gpu.balanceOf(bob), 7e18);
        uint256 issued4Delta = issuance.gpuConfig(H100).totalIssued - issued4;
        uint256 principal4Delta = pol.principalContributed(H100) - principal4;
        assertGt(issued4Delta, 0, "backstop participated");
        assertEq(
            principal4Delta, Math.mulDiv(issued4Delta, 25_000, issuance.compositionDivisor(), Math.Rounding.Ceil),
            "principal == ceil(base)"
        );
        uint256 ifee4 = Math.mulDiv(principal4Delta, 50, 10_000, Math.Rounding.Ceil);
        assertEq(
            gusd.balanceOf(address(ledger)) - ledger4, ifee4 + (hook.totalHookFeesGusd() - hookFees4),
            "ledger gets issuance fee + hook fee"
        );

        // 5) SELL 1 H100 -> USDC: pure secondary; native bids + the vault's
        //    bid inventory pay the seller, the vault acquires GPU at the bid
        uint256 bobUsdc = underlying.balanceOf(bob);
        uint256 bid5 = pol.bidInventoryGusd(H100);
        uint256 ask5 = pol.askInventoryGpu(H100);
        uint256 hookFees5 = hook.totalHookFeesGusd();
        uint256 out5 = _sellGpu(bob, 1e18, address(underlying), 2e6, bob); // helper pranks internally
        assertGe(out5, 2e6, "sell payout");
        assertEq(underlying.balanceOf(bob) - bobUsdc, out5, "sell payout delivered");
        assertEq(gpu.balanceOf(bob), 6e18);
        assertGt(hook.totalHookFeesGusd(), hookFees5, "hook fee on sell (gUSD, in-kind basis)");
        assertEq(pol.principalContributed(H100), principal4 + principal4Delta, "principal untouched by sells");
        assertLe(pol.bidInventoryGusd(H100), bid5, "bid capacity spent or refilled");
        assertGt(pol.askInventoryGpu(H100), ask5, "vault acquired GPU at the bid edge");

        // 6) distribute: fees already flowed to the ledger during the swaps;
        //    no harvest exists in C-max
        uint256 sgAssetsBefore = gusd.balanceOf(address(sg));
        uint256 treasuryBefore = gusd.balanceOf(treasury);
        ledger.distribute();
        assertEq(gusd.balanceOf(address(ledger)), 0, "ledger drained");
        assertGt(gusd.balanceOf(address(sg)), sgAssetsBefore, "vault funded");
        assertGt(gusd.balanceOf(treasury), treasuryBefore, "treasury funded");

        // Definition-of-Success
        assertEq(underlying.balanceOf(address(gusd)), gusd.totalSupply(), "reserve == supply");
        assertEq(gusd.balanceOf(address(router)), 0, "router holds no gUSD");
        assertEq(gpu.balanceOf(address(router)), 0, "router holds no GPU");
        assertEq(gusd.balanceOf(address(hook)), 0, "hook holds nothing at rest");
        assertEq(gusd.balanceOf(address(issuance)), 0, "issuance empty");
        assertGt(pol.principalContributed(H100), 250_000_000, "principal grew from backstop only");
        assertGt(pol.bidInventoryGusd(H100), 0, "bid capacity exists");
        assertGt(pol.askInventoryGpu(H100), 0, "ask inventory exists");
        assertGt(sg.convertToAssets(1e6), 1e6, "sgUSD share price up");
        assertEq(posm.balanceOf(address(router)), 0, "router holds no NFTs");
    }

    /// @notice Oracle reprice: next issuance reprices; pool + reserves do not.
    function test_oracleReprice() public {
        (uint256 base0,,) = issuance.quoteIssue(H100, 1e18);
        assertEq(base0, 2_500_000);
        (, int24 tickBefore,,) = stateView.getSlot0(poolId);
        uint256 principal = pol.principalContributed(H100);

        oracle.setPrice(H100, 30_000, block.timestamp); // $3.00

        (uint256 base1,,) = issuance.quoteIssue(H100, 1e18);
        assertEq(base1, 3_000_000, "issuance repriced");
        (, int24 tickAfter,,) = stateView.getSlot0(poolId);
        assertEq(tickBefore, tickAfter, "pool price moved?");
        assertEq(pol.principalContributed(H100), principal, "principal moved?");
    }

    /// @notice Oversized BUY on a cold-market-plus-LP rig: the native walk
    ///         and POL ask inventory are tiny, so the in-swap issuance
    ///         backstop mints the tail — elastic supply, quote == execution,
    ///         principal capitalizes the vault. No PoolShortfall exists in
    ///         C-max: capacity is structural (issuance), not a band.
    function test_oversizedBuy_backstopFills() public {
        _issueGpuTo(alice, 100e18); // full-range LP mint needs ~50 GPU
        _lpAlice();
        _buyGusd(bob, 5_000_000e6);
        vm.startPrank(bob);
        gusd.approve(address(router), type(uint256).max);
        vm.stopPrank();

        uint256 issued0 = issuance.gpuConfig(H100).totalIssued;
        uint256 principal0 = pol.principalContributed(H100); // alice's direct-issuance LP seed
        GpuQuoter.QuoteResult memory q = gq.quoteBuyExactOut(key, 1_000e18);
        assertEq(q.gpuOut, 1_000e18);
        assertEq(q.polGpu, 0, "no ask inventory on this rig");
        assertGt(q.backstopGpu, 0, "backstop covers the tail");

        vm.startPrank(bob);
        uint256 paid = _buyGpu(1_000e18, address(gusd), q.gusdIn, bob);
        vm.stopPrank();
        assertEq(paid, q.gusdIn, "quote == execution");
        assertEq(gpu.balanceOf(bob), 1_000e18, "full demand filled");
        assertEq(issuance.gpuConfig(H100).totalIssued - issued0, q.backstopGpu, "backstop minted the tail");
        assertEq(pol.principalContributed(H100), principal0 + q.issueBase, "principal capitalized");
        assertGt(pol.bidInventoryGusd(H100), 0, "bid capacity grew");
        assertEq(gusd.balanceOf(address(router)), 0, "router dust-free");
    }

    /// @notice Sell liquidity is honestly finite: the vault's bid inventory
    ///         plus the native book is all there is. A sell larger than the
    ///         merged book reverts InsufficientMarketCapacity; a finite sell
    ///         fills at the bid edge and the vault acquires GPU.
    function test_sell_honestBidLiquidity() public {
        // genesis: alice buys 100 -> vault bid capacity 250 gUSD
        vm.startPrank(alice);
        _buyGpu(100e18, address(gusd), 300e6, alice);
        vm.stopPrank();
        // bob acquires 1000 GPU via primary issuance, then tries to dump
        _buyGusd(bob, 5_000_000e6);
        vm.startPrank(bob);
        gusd.approve(address(issuance), type(uint256).max);
        issuance.issue(H100, 1_000e18, bob);
        IERC20(address(gpu)).approve(address(router), type(uint256).max);
        vm.stopPrank();
        // price x4: the vault's fixed gUSD bid now buys ~277 GPU, so a
        // 1,000-GPU dump exceeds the merged book (fresh issuance alone
        // can never exhaust it -- bid < issue price per GPU)
        oracle.setPrice(H100, 100_000, block.timestamp);

        uint256 bid0 = pol.bidInventoryGusd(H100);
        uint256 ask0 = pol.askInventoryGpu(H100);
        uint256 principal0 = pol.principalContributed(H100);

        // 1000 GPU exceeds the merged book: honest closed-market revert
        GpuRouter.SellParams memory big = GpuRouter.SellParams({
            gpuId: H100, gpuIn: 1_000e18, payout: address(gusd), minOut: 0, deadline: 0, sqrtLimitX96: 0, recipient: bob
        });
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
        router.sell(big);
        assertEq(gpu.balanceOf(bob), 1_000e18, "tokens intact");
        assertEq(pol.bidInventoryGusd(H100), bid0, "bid inventory untouched by revert");
        assertEq(pol.askInventoryGpu(H100), ask0, "ask inventory untouched by revert");

        // a finite size fills at the bid edge
        GpuRouter.SellParams memory small = GpuRouter.SellParams({
            gpuId: H100, gpuIn: 50e18, payout: address(gusd), minOut: 100e6, deadline: 0, sqrtLimitX96: 0, recipient: bob
        });
        vm.prank(bob);
        uint256 out = router.sell(small);
        vm.stopPrank();
        assertGe(out, 400e6, "bid-edge payout (50 x ~9.94 = 497)");
        assertLe(out, 520e6, "sell priced at/below the bid edge");
        assertEq(pol.principalContributed(H100), principal0, "principal untouched by sells");
        assertLt(pol.bidInventoryGusd(H100), bid0, "bid capacity spent");
        assertGt(pol.askInventoryGpu(H100), ask0, "vault acquired GPU at the bid");
        assertEq(gusd.balanceOf(address(router)), 0, "router dust-free");
    }

    /// @notice buyExactIn full fill: the GpuQuoter quote is execution-
    ///         identical, the caller spends exactly gusdMaxIn, POL ask
    ///         inventory fills beyond the edge, and the hook fee is charged
    ///         IN-KIND in GPU (totalHookFeesGusd must not move on this shape).
    function test_buyExactIn_quoteParity() public {
        // POL ask inventory: alice sells 50 GPU after a genesis buy
        vm.startPrank(alice);
        _buyGpu(100e18, address(gusd), 300e6, alice);
        IERC20(address(gpu)).approve(address(router), type(uint256).max);
        router.sell(
            GpuRouter.SellParams({
                gpuId: H100, gpuIn: 50e18, payout: address(gusd), minOut: 0, deadline: 0, sqrtLimitX96: 0,
                recipient: alice
            })
        );
        vm.stopPrank();
        assertGt(pol.askInventoryGpu(H100), 0, "vault holds ask inventory");

        _buyGusd(bob, 1_000_000e6);
        GpuQuoter.QuoteResult memory q = gq.quoteBuy(key, 10e6);
        assertGt(q.gpuOut, 0, "quote fills");
        assertGt(q.polGpu, 0, "POL ask fills beyond the edge");

        uint256 hookFees0 = hook.totalHookFeesGusd();
        vm.startPrank(bob);
        gusd.approve(address(router), type(uint256).max);
        uint256 gpuOut = router.buyExactIn(H100, 10e6, q.gpuOut, 0, 0, bob);
        vm.stopPrank();
        assertEq(gpuOut, q.gpuOut, "quote == execution");
        assertEq(q.hookFeeGusd, 0, "exactIn buy fee is in-kind, not gUSD");
        assertEq(hook.totalHookFeesGusd(), hookFees0, "totalHookFeesGusd unchanged (fee taken in GPU)");
        assertEq(gusd.balanceOf(bob), 1_000_000e6 - 10e6, "exact spend");
        assertEq(gusd.balanceOf(address(router)), 0, "router dust-free");
    }

    /// @notice Stale oracle: the hook fills NOTHING — no POL, no backstop,
    ///         no fees; small flows proceed pure-native through the LP book.
    function test_staleOracle_hookInert() public {
        _issueGpuTo(alice, 1_100e18);
        _lpAlice();
        vm.warp(block.timestamp + 26 hours); // staleness window: 25 hours

        (, , , bool live,,) = hook.polState(H100);
        assertFalse(live, "POL inert on stale oracle");

        uint256 polFees0 = hook.totalPolFeesGusd();
        uint256 hookFees0 = hook.totalHookFeesGusd();
        uint256 principal0 = pol.principalContributed(H100);
        uint256 issued0 = issuance.gpuConfig(H100).totalIssued;

        // small BUY proceeds pure-native (LPs only)
        vm.startPrank(alice);
        uint256 paid = _buyGpu(5e16, address(gusd), 200e6, alice);
        vm.stopPrank();
        assertGt(paid, 0, "native-only buy works");
        assertEq(hook.totalPolFeesGusd(), polFees0, "no POL fee when stale");
        assertEq(hook.totalHookFeesGusd(), hookFees0, "no hook fee when stale");
        assertEq(pol.principalContributed(H100), principal0, "no backstop when stale");
        assertEq(issuance.gpuConfig(H100).totalIssued, issued0, "no in-swap issuance when stale");

        // SELL also proceeds (never fabricates bid liquidity)
        uint256 out = _sellGpu(alice, 5e17, address(gusd), 1, alice);
        assertGt(out, 0, "native-only sell works");
        assertEq(hook.totalHookFeesGusd(), hookFees0, "sell also hook-free when stale");
    }
}
