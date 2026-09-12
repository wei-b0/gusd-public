// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev Indexer-verification variant of Demo.s.sol for a PARTIALLY demoed
///      chain: the canonical genesis buy already ran (Issued present), but the
///      chain clock was warped +11h between forge's simulation and broadcast,
///      so step 2 reverted DeadlinePassed and steps 2-7 never ran. This script
///      runs flows 2-7 WITHOUT Demo's virgin-state absolute-balance requires
///      (the chain is no longer virgin). Event coverage is identical to Demo
///      steps 2-7. Kept in the working tree as the indexer's dev-chain churn
///      script (Phase 6 anvil suite replays it); unlike Demo it tolerates
///      already-demoed state.
import {Script} from "forge-std/Script.sol";
import {TestnetOnly} from "./TestnetOnly.sol";
import {console2} from "forge-std/console2.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateView} from "@uniswap/v4-periphery/lens/StateView.sol";
import {PositionManager} from "@uniswap/v4-periphery/PositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {Actions} from "@uniswap/v4-periphery/libraries/Actions.sol";
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
import {GPUPriceOracle} from "../src/oracle/GPUPriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Indexer demo activity — seeded trades so the index has tape to
///         verify against. REFUSES mainnets (TestnetOnly).
contract IndexerDemo is Script, TestnetOnly {
    using PoolIdLibrary for PoolKey;

    bytes32 constant H100 = bytes32(bytes("H100_SXM_80GB"));
    uint256 constant ALICE_PK = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant BOB_PK = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;

    function run() external {
        _refuseOnMainnet();
        uint256 pk = vm.envUint("PRIVATE_KEY");
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
        PositionManager posm;
        assembly ("memory-safe") {
            posm := posmAddr
        }
        IERC20 underlying = IERC20(usdcAddr);
        GPUToken h100 = GPUToken(issuance.tokenOf(H100));
        StateView stateView = StateView(stateViewAddr);

        // canonical pool (registered at deploy time)
        PoolKey memory key = GpuPoolKey.canonical(gusdAddr, address(h100), issuance.poolParamsOf(H100), hook);
        PoolId poolId = key.toId();
        require(hook.poolGpuId(poolId) == H100, "pool not registered");
        bool gIsC0 = gusdAddr < address(h100);

        // 2) EXTERNAL LP via POSM (alice; approvals are idempotent)
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
        posm.modifyLiquidities(plan.finalizeModifyLiquidityWithClose(key), block.timestamp + 600);
        vm.stopBroadcast();
        require(stateView.getLiquidity(poolId) > 0, "step2 pool liquidity");

        // 3) BUY via pool (bob pays USDC; quote == execution via GpuQuoter)
        vm.startBroadcast(pk);
        MockERC20(usdcAddr).mint(bob, 1_000_000e6);
        vm.stopBroadcast();
        vm.startBroadcast(BOB_PK);
        underlying.approve(routerAddr, type(uint256).max);
        GpuQuoter.QuoteResult memory q3 = gpuQuoter.quoteBuyExactOut(key, 2e18);
        require(q3.gpuOut == 2e18 && q3.gusdIn > 0, "step3 quote shape");
        (uint256 f0, uint256 f1) = stateView.getFeeGrowthGlobals(poolId);
        uint256 fgBuy = gIsC0 ? f0 : f1;
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
        require(h100.balanceOf(bob) >= 2e18, "step3 tokens");
        (uint256 f0After, uint256 f1After) = stateView.getFeeGrowthGlobals(poolId);
        require((gIsC0 ? f0After : f1After) > fgBuy, "step3 LP fee accrued on native leg");

        // 4) BUY mixed legs (native -> POL -> backstop composed in-swap)
        vm.startBroadcast(BOB_PK);
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

        // 5) SELL
        vm.startBroadcast(BOB_PK);
        h100.approve(routerAddr, type(uint256).max);
        GpuRouter.SellParams memory s5 =
            GpuRouter.SellParams({gpuId: H100, gpuIn: 1e18, payout: usdcAddr, minOut: 2e6, deadline: 0, sqrtLimitX96: 0, recipient: bob});
        router.sell(s5);
        vm.stopBroadcast();

        // 6) oracle reprice -> instant, structural (polState + repriced buy)
        vm.startBroadcast(pk);
        GPUPriceOracle(oracleAddr).publish(H100, 30_000, block.timestamp);
        vm.stopBroadcast();
        (, , , bool live6, uint256 askPrice6, uint256 bidPrice6) = hook.polState(H100);
        require(live6, "step6 hook live");
        require(askPrice6 == 30_150 && bidPrice6 == 29_850, "step6 edges repriced in-swap");
        vm.startBroadcast(BOB_PK);
        underlying.approve(gusdAddr, type(uint256).max);
        gusd.mint(10e6, bob);
        gusd.approve(routerAddr, type(uint256).max);
        GpuQuoter.QuoteResult memory q6 = gpuQuoter.quoteBuyExactOut(key, 1e18);
        require(q6.gusdIn <= 3_015_000, "step6 blended at or below the new primary ask");
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
        require(paid6 == q6.gusdIn, "step6 quote == execution (repriced)");

        // 7) distribute protocol revenue (fees land on the ledger in-swap)
        vm.startBroadcast(pk);
        ledger.distribute();
        vm.stopBroadcast();
        require(gusd.balanceOf(ledgerAddr) == 0, "step7 ledger drained");

        console2.log("indexer demo complete: alice", alice);
        console2.log("indexer demo complete: bob", bob);
    }
}
