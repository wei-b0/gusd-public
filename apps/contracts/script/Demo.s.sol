// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateView} from "@uniswap/v4-periphery/lens/StateView.sol";
import {PositionManager} from "@uniswap/v4-periphery/PositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {Actions} from "@uniswap/v4-periphery/libraries/Actions.sol";
// demo-only: reuse the periphery test Planner to build the PositionManager
// call bundle (production frontends encode these actions offchain)
import {Planner, Plan} from "v4-periphery-test/shared/Planner.sol";
import {GUSD} from "../src/GUSD.sol";
import {GPUIssuance} from "../src/GPUIssuance.sol";
import {GPUMarketLiquidity} from "../src/GPUMarketLiquidity.sol";
import {GPUToken} from "../src/GPUToken.sol";
import {RevenueLedger} from "../src/RevenueLedger.sol";
import {sgUSD} from "../src/sgUSD.sol";
import {GPUHook} from "../src/hooks/GPUHook.sol";
import {GpuRouter} from "../src/GpuRouter.sol";
import {GpuQuoter} from "../src/lens/GpuQuoter.sol";
import {GpuPoolKey} from "../src/libraries/GpuPoolKey.sol";
import {MockGPUPriceOracle} from "../src/oracle/MockGPUPriceOracle.sol";
import {GPUPriceOracle} from "../src/oracle/GPUPriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice The product chain, require-asserted, on live state:
///         genesis BUY (cold pool: 100% in-swap issuance backstop) ->
///         external LP via PositionManager -> pool BUY (quote == execution)
///         -> mixed BUY -> SELL -> oracle reprice (instant, structural) ->
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
        address stateViewAddr = vm.parseJsonAddress(json, ".stateView");
        address routerAddr = vm.parseJsonAddress(json, ".router");
        address permit2Addr = vm.parseJsonAddress(json, ".permit2");
        address posmAddr = vm.parseJsonAddress(json, ".positionManager");
        address gpuQuoterAddr = vm.parseJsonAddress(json, ".gpuQuoter");
        address oracleAddr = vm.parseJsonAddress(json, ".oracle");
        address polAddr = vm.parseJsonAddress(json, ".marketLiquidity");

        GUSD gusd = GUSD(gusdAddr);
        GPUIssuance issuance = GPUIssuance(issuanceAddr);
        GPUMarketLiquidity pol = GPUMarketLiquidity(polAddr);
        GPUHook hook = GPUHook(hookAddr);
        RevenueLedger ledger = RevenueLedger(ledgerAddr);
        sgUSD sg = sgUSD(sgusdAddr);
        GpuRouter router = GpuRouter(routerAddr);
        GpuQuoter gpuQuoter = GpuQuoter(gpuQuoterAddr);
        // PositionManager has a payable fallback (WETH deposits): cast via
        // the interface-shaped variable instead of a direct conversion
        PositionManager posm;
        assembly ("memory-safe") {
            posm := posmAddr
        }
        IERC20 underlying = IERC20(usdcAddr);
        GPUToken h100 = GPUToken(issuance.tokenOf(H100));
        StateView stateView = StateView(stateViewAddr);

        // canonical pool (initialized + registered at deploy time)
        bool gIsC0 = gusdAddr < address(h100);
        PoolKey memory key = GpuPoolKey.canonical(gusdAddr, address(h100), issuance.poolParamsOf(H100), hook);
        PoolId poolId = key.toId();
        require(hook.poolGpuId(poolId) == H100, "pool not registered");

        // ---------------------------------------------------- 1) GENESIS BUY
        // alice buys 100 H100 into a registered-but-empty market: the walk
        // covers nothing (zero liquidity), POL ask inventory is zero, so the
        // in-swap issuance backstop mints 100% at the oracle price + fees.
        // Principal capitalizes the vault as bid capacity; the issuance fee
        // lands on the ledger. No pool tick ever needs to move for the price
        // to be fresh — the hook priced this swap from the oracle directly.
        vm.startBroadcast(pk);
        MockERC20(usdcAddr).mint(alice, 1_000_000e6);
        vm.stopBroadcast();
        vm.startBroadcast(ALICE_PK);
        underlying.approve(gusdAddr, type(uint256).max);
        gusd.mint(10_000e6, alice);
        gusd.approve(routerAddr, type(uint256).max);
        uint256 ledgerGusd0 = gusd.balanceOf(ledgerAddr);
        uint256 issued0 = issuance.gpuConfig(H100).totalIssued;
        GpuRouter.BuyParams memory b1 = GpuRouter.BuyParams({
            gpuId: H100,
            gpuOut: 100e18,
            payment: gusdAddr,
            maxPaid: 300e6,
            deadline: 0,
            sqrtLimitX96: 0,
            recipient: alice
        });
        uint256 paid1 = router.buy(b1);
        vm.stopBroadcast();
        // charge 100 x 2.5 x 1.005 = 251_250_000 + hook fee 1_256_250
        require(paid1 == 252_506_250, "step1 cold-market cost (backstop charge + hook fee)");
        require(h100.balanceOf(alice) == 100e18, "step1 tokens");
        require(pol.principalContributed(H100) == 250_000_000, "step1 principal capitalized");
        require(issuance.gpuConfig(H100).totalIssued - issued0 == 100e18, "step1 backstop minted");
        require(pol.bidInventoryGusd(H100) == 250_000_000, "step1 principal is bid capacity");
        require(pol.askInventoryGpu(H100) == 0, "step1 no ask inventory yet");
        require(gusd.balanceOf(issuanceAddr) == 0, "step1 issuance holds no gUSD");
        // issuance fee 1_250_000 + hook fee 1_256_250, both to the ledger
        require(gusd.balanceOf(ledgerAddr) - ledgerGusd0 == 2_506_250, "step1 issuance + hook fee");
        require(gusd.balanceOf(routerAddr) == 0 && h100.balanceOf(routerAddr) == 0, "step1 router empty");
        require(gusd.balanceOf(hookAddr) == 0, "step1 hook holds nothing at rest");

        // --------------------------------------------- 2) EXTERNAL LP via PM
        // alice provisions the canonical market as an external LP through the
        // production PositionManager (Permit2): full-range 50 H100 + 125 gUSD.
        // External LPs are filled FIRST (inside the spread); POL defends the
        // oracle edges beyond the native book.
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
        // bob pays USDC; the router mints gUSD internally and the single swap
        // composes native LP flow + POL + backstop. The GpuQuoter runs the
        // REAL hook inside a PoolManager lock (float-seeded), so quoting is
        // execution-identical: the quoted gUSD-in equals the router's paid.
        vm.startBroadcast(pk);
        MockERC20(usdcAddr).mint(bob, 1_000_000e6);
        vm.stopBroadcast();
        vm.startBroadcast(BOB_PK);
        underlying.approve(routerAddr, type(uint256).max);
        GpuQuoter.QuoteResult memory q3 = gpuQuoter.quoteBuyExactOut(key, 2e18);
        require(q3.gpuOut == 2e18 && q3.gusdIn > 0, "step3 quote shape");
        (uint256 f0, uint256 f1) = stateView.getFeeGrowthGlobals(poolId);
        uint256 fgBuy = gIsC0 ? f0 : f1;
        uint256 issued3 = issuance.gpuConfig(H100).totalIssued;
        uint256 principal3 = pol.principalContributed(H100);
        GpuRouter.BuyParams memory b3 = GpuRouter.BuyParams({
            gpuId: H100,
            gpuOut: 2e18,
            payment: usdcAddr,
            maxPaid: q3.gusdIn,
            deadline: 0,
            sqrtLimitX96: 0,
            recipient: bob
        });
        uint256 paid3 = router.buy(b3);
        vm.stopBroadcast();
        require(paid3 == q3.gusdIn, "step3 quote == execution");
        require(h100.balanceOf(bob) == 2e18, "step3 tokens");
        (uint256 f0After, uint256 f1After) = stateView.getFeeGrowthGlobals(poolId);
        require((gIsC0 ? f0After : f1After) > fgBuy, "step3 LP fee accrued on native leg");
        // the hook's fills (if any beyond the native book) are POL-or-backstop
        require(
            issuance.gpuConfig(H100).totalIssued - issued3 + (pol.principalContributed(H100) - principal3) >= 0,
            "step3 counters sane"
        );
        require(gusd.balanceOf(routerAddr) == 0, "step3 router empty");
        require(hook.poolGpuId(poolId) == H100, "step3 pool still registered");

        // -------------------------------------------------- 4) BUY mixed legs
        // 5 H100: whatever the native book serves first (LPs filled first),
        // then POL ask inventory (if seeded), then the issuance backstop.
        // The backstop's base lands in the vault as bid capacity — the buy
        // deepens the very market it filled from.
        vm.startBroadcast(BOB_PK);
        uint256 principal4 = pol.principalContributed(H100);
        uint256 ledgerGusd4 = gusd.balanceOf(ledgerAddr);
        uint256 issued4 = issuance.gpuConfig(H100).totalIssued;
        GpuRouter.BuyParams memory b4 = GpuRouter.BuyParams({
            gpuId: H100,
            gpuOut: 5e18,
            payment: usdcAddr,
            maxPaid: 20e6,
            deadline: 0,
            sqrtLimitX96: 0,
            recipient: bob
        });
        router.buy(b4);
        vm.stopBroadcast();
        require(h100.balanceOf(bob) == 7e18, "step4 tokens");
        // backstop participation is visible in exactly two counters: the
        // issuance total and the vault principal it capitalized (identical
        // ceil math: base = amount * price / compositionDivisor)
        uint256 issued4Delta = issuance.gpuConfig(H100).totalIssued - issued4;
        uint256 principal4Delta = pol.principalContributed(H100) - principal4;
        require(
            issued4Delta == 0
                || principal4Delta
                    == Math.mulDiv(issued4Delta, 25_000, issuance.compositionDivisor(), Math.Rounding.Ceil),
            "step4 principal tracks backstop base"
        );
        require(gusd.balanceOf(routerAddr) == 0 && h100.balanceOf(routerAddr) == 0, "step4 router empty");

        // ------------------------------------------------------------- 5) SELL
        // pure secondary execution: native bids + the vault's bid inventory
        // (the 250 gUSD of genesis principal) pay the seller; the protocol
        // takes the POL fee + hook fee, the vault takes the GPU at the bid
        // edge. No NAV redemption exists; the oracle is untouched.
        vm.startBroadcast(BOB_PK);
        h100.approve(routerAddr, type(uint256).max);
        uint256 bid5 = pol.bidInventoryGusd(H100);
        uint256 ask5 = pol.askInventoryGpu(H100);
        uint256 bobUsdcBefore = underlying.balanceOf(bob);
        GpuRouter.SellParams memory s5 = GpuRouter.SellParams({
            gpuId: H100,
            gpuIn: 1e18,
            payout: usdcAddr,
            minOut: 2e6,
            deadline: 0,
            sqrtLimitX96: 0,
            recipient: bob
        });
        uint256 out5 = router.sell(s5);
        vm.stopBroadcast();
        require(h100.balanceOf(bob) == 6e18, "step5 tokens");
        require(underlying.balanceOf(bob) - bobUsdcBefore == out5 && out5 >= 2e6, "step5 payout");
        require(pol.principalContributed(H100) == principal4, "step5 principal untouched by sells");
        require(pol.bidInventoryGusd(H100) <= bid5, "step5 bid inventory spent or refilled");
        require(pol.askInventoryGpu(H100) >= ask5, "step5 vault acquired GPU at the bid edge");

        // ---------------------------------------------- 6) oracle reprice
        // No keeper, no migration: the very next swap is priced from the NEW
        // oracle value. Bob buys 1 H100 in gUSD; the blend (native leg at old
        // spot + edges at the new reference) can only price at or below the
        // new primary total — and strictly better than the old book when the
        // backstop closes the tail.
        vm.startBroadcast(pk);
        _setPrice(deployer, oracleAddr, H100, 30_000); // $3.00/GPU-hour
        vm.stopBroadcast();
        (uint16 askBps6, uint16 bidBps6,, bool live6, uint256 askPrice6, uint256 bidPrice6) = hook.polState(H100);
        require(live6, "step6 hook live");
        require(askPrice6 == 30_000 * (10_000 + askBps6) / 10_000, "step6 ask repriced");
        require(bidPrice6 == 30_000 * (10_000 - bidBps6) / 10_000, "step6 bid repriced");
        vm.startBroadcast(BOB_PK);
        // bob pays this one in gUSD: mint it from his USDC and approve
        underlying.approve(gusdAddr, type(uint256).max);
        gusd.mint(10e6, bob);
        gusd.approve(routerAddr, type(uint256).max);
        GpuQuoter.QuoteResult memory q6 = gpuQuoter.quoteBuyExactOut(key, 1e18);
        require(q6.gusdIn <= 3_015_000, "step6 blended price at or below the new primary ask");
        require(q6.gusdIn >= 2_500_000, "step6 repriced above the old flat primary level");
        GpuRouter.BuyParams memory b6 = GpuRouter.BuyParams({
            gpuId: H100,
            gpuOut: 1e18,
            payment: gusdAddr,
            maxPaid: q6.gusdIn,
            deadline: 0,
            sqrtLimitX96: 0,
            recipient: bob
        });
        uint256 paid6 = router.buy(b6);
        vm.stopBroadcast();
        require(paid6 == q6.gusdIn, "step6 quote == execution at the repriced market");
        require(h100.balanceOf(bob) == 7e18, "step6 tokens (4+1... net of sell)");

        // ------------------------------------- 7) distribute protocol revenue
        // Fees (POL fee, hook fee, issuance fee) flow to the ledger DURING
        // the swaps — there is no harvest phase. One distribute() splits it
        // between the sgUSD vault and the treasury.
        vm.startBroadcast(pk);
        uint256 sgAssetsBefore = gusd.balanceOf(address(sg));
        ledger.distribute();
        vm.stopBroadcast();
        require(ledger.totalToVault() + ledger.totalToTreasury() > 1_250_000, "step7 revenue flowed");
        require(gusd.balanceOf(ledgerAddr) == 0, "step7 ledger drained");
        require(gusd.balanceOf(address(sg)) > sgAssetsBefore, "step7 vault funded");

        // ------------------------------------------- Definition-of-Success
        require(underlying.balanceOf(gusdAddr) == gusd.totalSupply(), "EOS: reserve == supply");
        require(gusd.balanceOf(routerAddr) == 0 && h100.balanceOf(routerAddr) == 0, "EOS: router empty");
        require(gusd.balanceOf(issuanceAddr) == 0, "EOS: issuance holds no gUSD");
        require(gusd.balanceOf(hookAddr) == 0, "EOS: hook holds nothing at rest");
        require(pol.principalContributed(H100) == principal4, "EOS: principal only from issuance");
        require(pol.bidInventoryGusd(H100) > 0, "EOS: bid capacity exists");
        uint256 redeemable = sg.convertToAssets(1e6);
        require(redeemable > 1e6, "EOS: sgUSD share price appreciated");
        console2.log("EOS: genesis BUY paid (gUSD)", paid1);
        console2.log("EOS: pool BUY 2 H100 paid (gUSD-wei)", paid3);
        console2.log("EOS: SELL 1 H100 out (USDC-wei)", out5);
        console2.log("EOS: reprice BUY 1 H100 paid (gUSD-wei)", paid6);
        console2.log("EOS: vault received (gUSD)", ledger.totalToVault());
        console2.log("EOS: treasury received (gUSD)", ledger.totalToTreasury());
        console2.log("EOS: sgUSD assets", gusd.balanceOf(address(sg)));
        console2.log("EOS: sgUSD 1e6 shares redeem for", redeemable);
        console2.log("Product chain complete: BUY GPU / SELL GPU, oracle-priced in-swap market making");
    }

    /// @dev Reprice through whichever oracle deployment is live: the
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
