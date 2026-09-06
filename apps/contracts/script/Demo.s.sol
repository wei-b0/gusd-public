// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateView} from "@uniswap/v4-periphery/lens/StateView.sol";
import {PositionManager} from "@uniswap/v4-periphery/PositionManager.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/interfaces/IV4Quoter.sol";
import {V4Quoter} from "@uniswap/v4-periphery/lens/V4Quoter.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {Actions} from "@uniswap/v4-periphery/libraries/Actions.sol";
// demo-only: reuse the periphery test Planner to build the PositionManager
// call bundle (production frontends encode these actions offchain)
import {Planner, Plan} from "v4-periphery-test/shared/Planner.sol";
import {GUSD} from "../src/GUSD.sol";
import {GPUIssuance} from "../src/GPUIssuance.sol";
import {GPUToken} from "../src/GPUToken.sol";
import {RevenueLedger} from "../src/RevenueLedger.sol";
import {sgUSD} from "../src/sgUSD.sol";
import {GPUHook} from "../src/hooks/GPUHook.sol";
import {GpuRouter} from "../src/GpuRouter.sol";
import {IGPUIssuance} from "../src/interfaces/IGPUIssuance.sol";
import {MockGPUPriceOracle} from "../src/oracle/MockGPUPriceOracle.sol";
import {GPUPriceOracle} from "../src/oracle/GPUPriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice The Milestone-2 product chain, require-asserted, on live state:
///         genesis BUY (100% issuance) -> external LP via PositionManager ->
///         BUY via pool -> mixed BUY -> SELL -> oracle reprice -> harvest ->
///         distribute -> sgUSD accrual. Every flow is a single router call.
contract Demo is Script {
    using PoolIdLibrary for PoolKey;

    bytes32 constant H100 = bytes32(bytes("H100_SXM_80GB"));

    // anvil rich keys (demo-only): deployer = #0, alice = #2, bob = #3
    uint256 constant ALICE_PK = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant BOB_PK = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address alice = vm.addr(ALICE_PK);
        address bob = vm.addr(BOB_PK);
        string memory json = vm.readFile(string.concat("./deployments/", vm.toString(block.chainid), ".json"));
        address gusdAddr = vm.parseJsonAddress(json, ".gusd");
        address issuanceAddr = vm.parseJsonAddress(json, ".issuance");
        address hookAddr = vm.parseJsonAddress(json, ".hook");
        address ledgerAddr = vm.parseJsonAddress(json, ".ledger");
        address sgusdAddr = vm.parseJsonAddress(json, ".sgusd");
        address usdcAddr = vm.parseJsonAddress(json, ".underlying");
        address managerAddr = vm.parseJsonAddress(json, ".poolManager");
        address stateViewAddr = vm.parseJsonAddress(json, ".stateView");
        address routerAddr = vm.parseJsonAddress(json, ".router");
        address permit2Addr = vm.parseJsonAddress(json, ".permit2");
        address posmAddr = vm.parseJsonAddress(json, ".positionManager");
        address quoterAddr = vm.parseJsonAddress(json, ".quoter");
        address oracleAddr = vm.parseJsonAddress(json, ".oracle");

        GUSD gusd = GUSD(gusdAddr);
        GPUIssuance issuance = GPUIssuance(issuanceAddr);
        GPUHook hook = GPUHook(hookAddr);
        RevenueLedger ledger = RevenueLedger(ledgerAddr);
        sgUSD sg = sgUSD(sgusdAddr);
        GpuRouter router = GpuRouter(routerAddr);
        // PositionManager has a payable fallback (WETH deposits): cast via
        // the interface-shaped variable instead of a direct conversion
        PositionManager posm;
        assembly ("memory-safe") {
            posm := posmAddr
        }
        IV4Quoter quoter = IV4Quoter(quoterAddr);
        IERC20 underlying = IERC20(usdcAddr);
        GPUToken h100 = GPUToken(issuance.tokenOf(H100));
        StateView stateView = StateView(stateViewAddr);

        // canonical pool (initialized + registered at deploy time)
        bool gIsC0 = gusdAddr < address(h100);
        PoolKey memory key;
        key.currency0 = gIsC0 ? Currency.wrap(gusdAddr) : Currency.wrap(address(h100));
        key.currency1 = gIsC0 ? Currency.wrap(address(h100)) : Currency.wrap(gusdAddr);
        IGPUIssuance.PoolParams memory pp = issuance.poolParamsOf(H100);
        key.fee = pp.fee;
        key.tickSpacing = pp.tickSpacing;
        key.hooks = hook;
        PoolId poolId = key.toId();
        require(hook.poolGpuId(poolId) == H100, "pool not registered");

        // ---------------------------------------------------- 1) GENESIS BUY
        // alice funds herself with gUSD, then buys 100 H100 from a market with
        // zero circulating supply and zero pool liquidity: 100% primary
        // issuance at the oracle price + 0.5% issuance fee, no pool leg.
        vm.startBroadcast(pk);
        MockERC20(usdcAddr).mint(alice, 1_000_000e6);
        vm.stopBroadcast();
        vm.startBroadcast(ALICE_PK);
        underlying.approve(gusdAddr, type(uint256).max);
        gusd.mint(10_000e6, alice);
        gusd.approve(routerAddr, type(uint256).max);
        uint256 hookFees0 = hook.totalTradingFeesAccrued();
        uint256 ledgerGusd0 = gusd.balanceOf(ledgerAddr);
        GpuRouter.BuyParams memory b1 = GpuRouter.BuyParams({
            gpuId: H100,
            gpuOut: 100e18,
            poolGpuOut: 0,
            issueGpuOut: 100e18,
            payment: gusdAddr,
            maxPaid: 300e6,
            sqrtLimitX96: 0,
            recipient: alice
        });
        uint256 paid1 = router.buy(b1);
        vm.stopBroadcast();
        require(paid1 == 251_250_000, "step1 genesis cost (100 x 2.5 x 1.005)");
        require(h100.balanceOf(alice) == 100e18, "step1 tokens");
        require(issuance.gpuReserve(H100) == 250_000_000, "step1 reserve");
        require(hook.totalTradingFeesAccrued() == hookFees0, "step1 no hook fee on genesis");
        require(gusd.balanceOf(ledgerAddr) - ledgerGusd0 == 1_250_000, "step1 issuance fee");
        require(gusd.balanceOf(routerAddr) == 0 && h100.balanceOf(routerAddr) == 0, "step1 router empty");

        // --------------------------------------------- 2) EXTERNAL LP via PM
        // alice provisions the canonical market as an external LP through the
        // production PositionManager (Permit2): full-range 50 H100 + 125 gUSD.
        vm.startBroadcast(ALICE_PK);
        h100.approve(permit2Addr, type(uint256).max);
        gusd.approve(permit2Addr, type(uint256).max);
        IAllowanceTransfer(permit2Addr).approve(address(h100), posmAddr, type(uint160).max, type(uint48).max);
        IAllowanceTransfer(permit2Addr).approve(gusdAddr, posmAddr, type(uint160).max, type(uint48).max);
        Plan memory plan = Planner.init();
        plan.add(
            Actions.MINT_POSITION,
            abi.encode(key, -887220, 887220, 7.9e13, type(uint128).max, type(uint128).max, alice, "")
        );
        // 10-minute deadline: forge's pre-broadcast validation forks anvil at a
        // later block than the simulation run that recorded this calldata, so a
        // +1s deadline reverts DeadlinePassed during broadcast (a production
        // frontend uses minutes-long deadlines for the same reason)
        posm.modifyLiquidities(plan.finalizeModifyLiquidityWithClose(key), block.timestamp + 600);
        vm.stopBroadcast();
        require(stateView.getLiquidity(poolId) > 0, "step2 pool liquidity");
        require(posm.ownerOf(1) == alice, "step2 position nft");

        // --------------------------------------------------- 3) BUY via pool
        // bob pays USDC; the router mints gUSD internally, swaps the pool leg
        // (0.30% LP fee + 0.50% protocol trading fee), refunds the change.
        // The quoter runs the hook, so quoting == executing.
        vm.startBroadcast(pk);
        MockERC20(usdcAddr).mint(bob, 1_000_000e6);
        vm.stopBroadcast();
        vm.startBroadcast(BOB_PK);
        underlying.approve(routerAddr, type(uint256).max);
        (uint256 quotedIn,) = quoter.quoteExactOutputSingle(
            IV4Quoter.QuoteExactSingleParams({poolKey: key, zeroForOne: gIsC0, exactAmount: 2e18, hookData: ""})
        );
        uint256 hookFees1 = hook.totalTradingFeesAccrued();
        // LP swap fees accrue in the swap INPUT currency (gUSD on a BUY); pick
        // the gUSD fee-growth slot by the pool's currency ordering
        (uint256 f0, uint256 f1) = stateView.getFeeGrowthGlobals(poolId);
        uint256 fgBuy = gIsC0 ? f0 : f1;
        GpuRouter.BuyParams memory b3 = GpuRouter.BuyParams({
            gpuId: H100,
            gpuOut: 2e18,
            poolGpuOut: 2e18,
            issueGpuOut: 0,
            payment: usdcAddr,
            maxPaid: quotedIn,
            sqrtLimitX96: 0,
            recipient: bob
        });
        uint256 paid3 = router.buy(b3);
        vm.stopBroadcast();
        require(paid3 == quotedIn, "step3 quote == execution");
        require(h100.balanceOf(bob) == 2e18, "step3 tokens");
        require(hook.totalTradingFeesAccrued() > hookFees1, "step3 hook fee accrued");
        (uint256 f0After, uint256 f1After) = stateView.getFeeGrowthGlobals(poolId);
        require((gIsC0 ? f0After : f1After) > fgBuy, "step3 LP fee accrued");
        require(gusd.balanceOf(routerAddr) == 0, "step3 router empty");

        // -------------------------------------------------- 4) BUY mixed legs
        // 5 H100: 3 from the pool + 2 minted via issuance; the pool leg keeps
        // the market deep while issuance tops it up at the oracle ceiling.
        vm.startBroadcast(BOB_PK);
        uint256 reserve4 = issuance.gpuReserve(H100);
        uint256 ledgerGusd4 = gusd.balanceOf(ledgerAddr);
        GpuRouter.BuyParams memory b4 = GpuRouter.BuyParams({
            gpuId: H100,
            gpuOut: 5e18,
            poolGpuOut: 3e18,
            issueGpuOut: 2e18,
            payment: usdcAddr,
            maxPaid: 20e6,
            sqrtLimitX96: 0,
            recipient: bob
        });
        router.buy(b4);
        vm.stopBroadcast();
        require(h100.balanceOf(bob) == 7e18, "step4 tokens");
        require(issuance.gpuReserve(H100) - reserve4 == 5_000_000, "step4 issuance reserve (2 x 2.5)");
        require(gusd.balanceOf(ledgerAddr) - ledgerGusd4 == 25_000, "step4 issuance fee (0.5% of 5)");
        require(gusd.balanceOf(routerAddr) == 0 && h100.balanceOf(routerAddr) == 0, "step4 router empty");

        // ------------------------------------------------------------- 5) SELL
        // pure secondary execution: pool swap only, proceeds in USDC via the
        // internal gUSD redeem; no NAV redemption, oracle untouched.
        vm.startBroadcast(BOB_PK);
        h100.approve(routerAddr, type(uint256).max);
        uint256 hookFees5 = hook.totalTradingFeesAccrued();
        uint256 bobUsdcBefore = underlying.balanceOf(bob);
        GpuRouter.SellParams memory s5 = GpuRouter.SellParams({
            gpuId: H100, gpuIn: 1e18, payout: usdcAddr, minOut: 2e6, sqrtLimitX96: 0, recipient: bob
        });
        uint256 out5 = router.sell(s5);
        vm.stopBroadcast();
        require(h100.balanceOf(bob) == 6e18, "step5 tokens");
        require(underlying.balanceOf(bob) - bobUsdcBefore == out5 && out5 >= 2e6, "step5 payout");
        require(hook.totalTradingFeesAccrued() > hookFees5, "step5 hook fee accrued");
        require(issuance.gpuReserve(H100) == 255_000_000, "step5 reserves untouched by trades");

        // ---------------------------------------------- 6) oracle reprice
        // the pool and reserves are untouched; only the NEXT issuance reprices
        (, int24 tickBefore,,) = stateView.getSlot0(poolId);
        vm.startBroadcast(pk);
        _setPrice(deployer, oracleAddr, H100, 30_000); // $3.00/GPU-hour
        vm.stopBroadcast();
        vm.startBroadcast(BOB_PK);
        // bob pays this one in gUSD: mint it from his USDC and approve
        underlying.approve(gusdAddr, type(uint256).max);
        gusd.mint(10e6, bob);
        gusd.approve(routerAddr, type(uint256).max);
        (uint256 base6,,) = issuance.quoteIssue(H100, 1e18);
        GpuRouter.BuyParams memory b6 = GpuRouter.BuyParams({
            gpuId: H100,
            gpuOut: 1e18,
            poolGpuOut: 0,
            issueGpuOut: 1e18,
            payment: gusdAddr,
            maxPaid: 5e6,
            sqrtLimitX96: 0,
            recipient: bob
        });
        uint256 paid6 = router.buy(b6);
        vm.stopBroadcast();
        require(base6 == 3_000_000 && paid6 == 3_015_000, "step6 repriced issuance (1 x 3 x 1.005)");
        (, int24 tickAfter,,) = stateView.getSlot0(poolId);
        require(tickBefore == tickAfter, "step6 pool price moved?");

        // --------------------------------- 7) harvest protocol revenue -> sgUSD
        // LP revenue stays in the pool for LPs; the hook's gUSD trading fees
        // flow to the ledger and split to the sgUSD vault + treasury.
        vm.startBroadcast(pk);
        hook.harvestTradingFees(poolId, 0);
        require(hook.pendingTradingFees(poolId) == 0, "step7 harvested");
        uint256 sgAssetsBefore = gusd.balanceOf(address(sg));
        ledger.distribute();
        vm.stopBroadcast();
        require(ledger.totalToVault() + ledger.totalToTreasury() > 1_250_000, "step7 revenue flowed");
        require(gusd.balanceOf(ledgerAddr) == 0, "step7 ledger drained");
        require(gusd.balanceOf(address(sg)) > sgAssetsBefore, "step7 vault funded");

        // ------------------------------------------- Definition-of-Success
        require(underlying.balanceOf(gusdAddr) == gusd.totalSupply(), "EOS: reserve == supply");
        require(gusd.balanceOf(routerAddr) == 0 && h100.balanceOf(routerAddr) == 0, "EOS: router empty");
        require(issuance.gpuReserve(H100) == 258_000_000, "EOS: issuance reserve (250 + 5 + 3)");
        require(gusd.balanceOf(address(hook)) == 0, "EOS: hook drained");
        uint256 redeemable = sg.convertToAssets(1e6);
        require(redeemable > 1e6, "EOS: sgUSD share price appreciated");
        console2.log("EOS: genesis BUY paid (gUSD)", paid1);
        console2.log("EOS: pool BUY 2 H100 paid (gUSD-wei)", paid3);
        console2.log("EOS: SELL 1 H100 out (USDC-wei)", out5);
        console2.log("EOS: hook trading fees harvested", hook.totalTradingFeesHarvested());
        console2.log("EOS: vault received (gUSD)", ledger.totalToVault());
        console2.log("EOS: treasury received (gUSD)", ledger.totalToTreasury());
        console2.log("EOS: sgUSD assets", gusd.balanceOf(address(sg)));
        console2.log("EOS: sgUSD 1e6 shares redeem for", redeemable);
        console2.log("M2 product chain complete: BUY GPU / SELL GPU");
    }

    /// @dev Step-6 reprice through whichever oracle deployment is live: the
    ///      production GPUPriceOracle (publish() when the deployer is the
    ///      publisher, setPriceOverride() when a separate PUBLISHER was
    ///      granted) or the legacy owner-gated mock.
    function _setPrice(address deployer, address oracleAddr, bytes32 gpuId, uint256 price) internal {
        try GPUPriceOracle(oracleAddr).publisher() returns (address pub) {
            if (pub == deployer) {
                GPUPriceOracle(oracleAddr).publish(gpuId, price, block.timestamp);
            } else {
                GPUPriceOracle(oracleAddr).setPriceOverride(gpuId, price, block.timestamp);
            }
        } catch {
            MockGPUPriceOracle(oracleAddr).setPrice(gpuId, price, block.timestamp);
        }
    }
}
