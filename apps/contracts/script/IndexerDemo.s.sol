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
import {console2} from "forge-std/console2.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateView} from "@uniswap/v4-periphery/lens/StateView.sol";
import {PositionManager} from "@uniswap/v4-periphery/PositionManager.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/interfaces/IV4Quoter.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {Actions} from "@uniswap/v4-periphery/libraries/Actions.sol";
import {Planner, Plan} from "v4-periphery-test/shared/Planner.sol";
import {GUSD} from "../src/GUSD.sol";
import {GPUIssuance} from "../src/GPUIssuance.sol";
import {GPUToken} from "../src/GPUToken.sol";
import {RevenueLedger} from "../src/RevenueLedger.sol";
import {sgUSD} from "../src/sgUSD.sol";
import {GPUHook} from "../src/hooks/GPUHook.sol";
import {GpuRouter} from "../src/GpuRouter.sol";
import {IGPUIssuance} from "../src/interfaces/IGPUIssuance.sol";
import {GPUPriceOracle} from "../src/oracle/GPUPriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract IndexerDemo is Script {
    using PoolIdLibrary for PoolKey;

    bytes32 constant H100 = bytes32(bytes("H100_SXM_80GB"));
    uint256 constant ALICE_PK = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant BOB_PK = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address alice = vm.addr(ALICE_PK);
        address bob = vm.addr(BOB_PK);
        string memory json = vm.readFile("./deployments/31337.json");
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
        address quoterAddr = vm.parseJsonAddress(json, ".quoter");
        address oracleAddr = vm.parseJsonAddress(json, ".oracle");

        GUSD gusd = GUSD(gusdAddr);
        GPUIssuance issuance = GPUIssuance(issuanceAddr);
        GPUHook hook = GPUHook(hookAddr);
        RevenueLedger ledger = RevenueLedger(ledgerAddr);
        sgUSD sg = sgUSD(sgusdAddr);
        GpuRouter router = GpuRouter(routerAddr);
        PositionManager posm;
        assembly ("memory-safe") {
            posm := posmAddr
        }
        IV4Quoter quoter = IV4Quoter(quoterAddr);
        IERC20 underlying = IERC20(usdcAddr);
        GPUToken h100 = GPUToken(issuance.tokenOf(H100));
        StateView stateView = StateView(stateViewAddr);

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

        // 3) BUY via pool (bob pays USDC)
        vm.startBroadcast(pk);
        MockERC20(usdcAddr).mint(bob, 1_000_000e6);
        vm.stopBroadcast();
        vm.startBroadcast(BOB_PK);
        underlying.approve(routerAddr, type(uint256).max);
        (uint256 quotedIn,) = quoter.quoteExactOutputSingle(
            IV4Quoter.QuoteExactSingleParams({poolKey: key, zeroForOne: gIsC0, exactAmount: 2e18, hookData: ""})
        );
        GpuRouter.BuyParams memory b3 = GpuRouter.BuyParams({
            gpuId: H100, gpuOut: 2e18, poolGpuOut: 2e18, issueGpuOut: 0, payment: usdcAddr, maxPaid: quotedIn, sqrtLimitX96: 0, recipient: bob
        });
        router.buy(b3);
        vm.stopBroadcast();

        // 4) BUY mixed legs
        vm.startBroadcast(BOB_PK);
        GpuRouter.BuyParams memory b4 = GpuRouter.BuyParams({
            gpuId: H100, gpuOut: 5e18, poolGpuOut: 3e18, issueGpuOut: 2e18, payment: usdcAddr, maxPaid: 20e6, sqrtLimitX96: 0, recipient: bob
        });
        router.buy(b4);
        vm.stopBroadcast();

        // 5) SELL
        vm.startBroadcast(BOB_PK);
        h100.approve(routerAddr, type(uint256).max);
        GpuRouter.SellParams memory s5 =
            GpuRouter.SellParams({gpuId: H100, gpuIn: 1e18, payout: usdcAddr, minOut: 2e6, sqrtLimitX96: 0, recipient: bob});
        router.sell(s5);
        vm.stopBroadcast();

        // 6) oracle reprice -> publish + repriced issuance buy paid in gUSD
        vm.startBroadcast(pk);
        GPUPriceOracle(oracleAddr).publish(H100, 30_000, block.timestamp);
        vm.stopBroadcast();
        vm.startBroadcast(BOB_PK);
        underlying.approve(gusdAddr, type(uint256).max);
        gusd.mint(10e6, bob);
        gusd.approve(routerAddr, type(uint256).max);
        GpuRouter.BuyParams memory b6 = GpuRouter.BuyParams({
            gpuId: H100, gpuOut: 1e18, poolGpuOut: 0, issueGpuOut: 1e18, payment: gusdAddr, maxPaid: 5e6, sqrtLimitX96: 0, recipient: bob
        });
        router.buy(b6);
        vm.stopBroadcast();

        // 7) harvest protocol revenue -> sgUSD
        vm.startBroadcast(pk);
        hook.harvestTradingFees(poolId, 0);
        ledger.distribute();
        vm.stopBroadcast();

        console2.log("indexer demo complete: alice", alice);
        console2.log("indexer demo complete: bob", bob);
    }
}
