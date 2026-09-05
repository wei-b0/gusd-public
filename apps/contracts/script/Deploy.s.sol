// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {WETH} from "solmate/src/tokens/WETH.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateView} from "@uniswap/v4-periphery/lens/StateView.sol";
import {PositionManager} from "@uniswap/v4-periphery/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/PositionDescriptor.sol";
import {V4Quoter} from "@uniswap/v4-periphery/lens/V4Quoter.sol";
import {IWETH9} from "@uniswap/v4-periphery/interfaces/external/IWETH9.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {Permit2RuntimeDeployer} from "./Permit2RuntimeDeployer.sol";
import {GUSD} from "../src/GUSD.sol";
import {sgUSD} from "../src/sgUSD.sol";
import {RevenueLedger} from "../src/RevenueLedger.sol";
import {GPUIssuance} from "../src/GPUIssuance.sol";
import {GPUHook} from "../src/hooks/GPUHook.sol";
import {GpuRouter} from "../src/GpuRouter.sol";
import {GPUPriceOracle} from "../src/oracle/GPUPriceOracle.sol";
import {IGPUPriceOracle} from "../src/oracle/IGPUPriceOracle.sol";
import {IGPUIssuance} from "../src/interfaces/IGPUIssuance.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HookMiner} from "v4-periphery-test/shared/HookMiner.sol";

/// @notice Chain-agnostic deployment of the V2 protocol stack: core primitives,
///         the 0x10CC trading-fee hook, the BUY/SELL product router, and the
///         production periphery (Permit2/WETH/Descriptor/PositionManager/Quoter)
///         that external LPs provision the canonical pools through.
contract Deploy is Script {
    using PoolIdLibrary for PoolKey;

    // CREATE2 default proxy used by forge scripts
    address constant CREATE2_PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // canonical Permit2 deployment address (etched on empty chains via the
    // precompiled bytecode, reused as-is where it already exists)
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    uint160 constant HOOK_FLAGS = uint160(
        Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    struct Deployment {
        address usdc;
        address poolManager;
        address stateView;
        address gusd;
        address sgusd;
        address ledger;
        address issuance;
        address oracle;
        address hook;
        address router;
        address permit2;
        address positionManager;
        address quoter;
        address weth;
        uint256 chainId;
    }

    function run() external returns (Deployment memory d) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        vm.startBroadcast(pk);

        // 1) underlying + oracle (env overrides for real assets)
        address underlyingEnv = vm.envOr("UNDERLYING", address(0));
        address oracleEnv = vm.envOr("ORACLE", address(0));
        bool oracleDeployed;
        if (underlyingEnv != address(0)) {
            d.usdc = underlyingEnv;
        } else {
            MockERC20 u = new MockERC20("USD Coin", "USDC", 6);
            d.usdc = address(u);
        }
        if (oracleEnv != address(0)) {
            // external oracle: wired verbatim and never seeded here — prices
            // arrive through its own publication path; issuance fails closed
            // (OraclePriceZero) until it publishes
            d.oracle = oracleEnv;
        } else {
            address publisherEnv = vm.envOr("PUBLISHER", deployer);
            uint256 devBps = vm.envOr("ORACLE_MAX_DEVIATION_BPS", uint256(0));
            require(devBps <= type(uint16).max, "ORACLE_MAX_DEVIATION_BPS too large");
            d.oracle = address(new GPUPriceOracle(deployer, publisherEnv, uint16(devBps)));
            oracleDeployed = true;
        }

        // 2) v4 core + production periphery (LP surface + offchain quoting)
        d.poolManager = address(new PoolManager(deployer));
        d.stateView = address(new StateView(IPoolManager(d.poolManager)));
        d.permit2 = _ensurePermit2();
        d.weth = address(new WETH());
        d.positionManager = address(
            new PositionManager(
                IPoolManager(d.poolManager),
                IAllowanceTransfer(d.permit2),
                100_000, // unsubscribeGasLimit
                new PositionDescriptor(IPoolManager(d.poolManager), d.weth, "ETH"),
                IWETH9(d.weth)
            )
        );
        d.quoter = address(new V4Quoter(IPoolManager(d.poolManager)));

        // 3) protocol primitives
        d.gusd = address(new GUSD(IERC20(d.usdc), deployer));
        d.sgusd = address(new sgUSD(IERC20(d.gusd), deployer));
        d.ledger = address(new RevenueLedger(IERC20(d.gusd), deployer));
        d.issuance = address(new GPUIssuance(IERC20(d.gusd), IGPUPriceOracle(d.oracle), d.ledger, deployer));

        // 4) mine + deploy the 0x10CC hook against the CREATE2 proxy
        bytes memory ctorArgs = abi.encode(IPoolManager(d.poolManager), d.gusd, d.issuance, d.ledger, deployer);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(CREATE2_PROXY, HOOK_FLAGS, type(GPUHook).creationCode, ctorArgs);
        d.hook = address(
            new GPUHook{salt: salt}(IPoolManager(d.poolManager), d.gusd, GPUIssuance(d.issuance), d.ledger, deployer)
        );
        require(d.hook == hookAddr, "hook address mismatch");

        // 5) product router
        d.router = address(
            new GpuRouter(
                IPoolManager(d.poolManager), GUSD(d.gusd), GPUIssuance(d.issuance), GPUHook(d.hook), IERC20(d.usdc)
            )
        );

        // 6) wiring — no protocolFeeController: the hook captures the protocol
        //    trading share itself (gUSD-denominated in both directions)
        GUSD(d.gusd).setRevenueSink(d.ledger);
        GUSD(d.gusd).setFees(0, 0);
        RevenueLedger(d.ledger).setVault(d.sgusd);
        RevenueLedger(d.ledger).setTreasury(vm.envOr("TREASURY", deployer));
        RevenueLedger(d.ledger).setSplit(5_000);
        GPUHook(d.hook).setHookFeeBps(50);
        // seed the sgUSD vault: 1 gUSD in, 1 share out (one-way gate)
        MockERC20(d.usdc).mint(deployer, 1e6);
        IERC20(d.usdc).approve(d.gusd, 1e6);
        GUSD(d.gusd).mintUSDC(1e6, deployer);
        GUSD(d.gusd).approve(d.sgusd, 1e6);
        sgUSD(d.sgusd).seed(1e6);
        require(uint160(d.hook) & Hooks.ALL_HOOK_MASK == HOOK_FLAGS, "hook flags mismatch");

        // 7) canonical GPU: register H100, enable issuance, seed the oracle
        //    price, and initialize the canonical (empty) pool so the market is
        //    live at deploy time; genesis BUYs are 100% issuance until LPs add
        //    depth through the PositionManager.
        bytes32 h100Id = bytes32(bytes("H100_SXM_80GB"));
        GPUIssuance(d.issuance).createGpu(h100Id, "H100 SXM 80GB GPU-hour", "H100", 50, 3000, 60);
        GPUIssuance(d.issuance).setIssuanceEnabled(h100Id, true);
        if (oracleDeployed) {
            // genesis seed via the owner hatch: works for any PUBLISHER value,
            // including a publisher key the deployer does not control
            GPUPriceOracle(d.oracle).setPriceOverride(h100Id, 25_000, block.timestamp); // $2.50/GPU-hour
        } else {
            // _initializeCanonicalPool below derives the pool's starting price
            // from the live oracle: an external oracle must have published.
            console2.log("oracle external; pool initializes at the oracle's live price");
        }
        _initializeCanonicalPool(d, h100Id);

        vm.stopBroadcast();
        _persist(d, oracleDeployed);
        console2.log("gusd", d.gusd);
        console2.log("hook", d.hook);
        console2.log("router", d.router);
        console2.log("positionManager", d.positionManager);
    }

    /// @dev Reuse the canonical Permit2 deployment wherever it exists (any
    ///      live chain); on empty chains (fresh anvil) deploy the identical
    ///      bytecode at a fresh address via CREATE (vm.etch is unavailable in
    ///      broadcast mode and Permit2 pins solc 0.8.17).
    function _ensurePermit2() internal returns (address) {
        if (PERMIT2.code.length > 0) return PERMIT2;
        return new Permit2RuntimeDeployer().deploy();
    }

    /// @dev Initialize the canonical pool at the LIVE oracle price. The pool's
    ///      sqrtPriceX96 is sqrt(c1/c0) * 2^96; the oracle reports a gUSD-wei
    ///      per GPU-wei ratio, so use it directly when GPU is currency1 and
    ///      invert it at the radicand level when the ordering flips. An
    ///      external oracle that has never published fails the deploy — the
    ///      canonical pool refuses to start at a fabricated price (fail closed).
    function _initializeCanonicalPool(Deployment memory d, bytes32 gpuId) internal {
        address gpuToken = GPUIssuance(d.issuance).tokenOf(gpuId);
        IGPUIssuance.PoolParams memory pp = GPUIssuance(d.issuance).poolParamsOf(gpuId);
        (Currency c0, Currency c1) = d.gusd < gpuToken
            ? (Currency.wrap(d.gusd), Currency.wrap(gpuToken))
            : (Currency.wrap(gpuToken), Currency.wrap(d.gusd));
        PoolKey memory key =
            PoolKey({currency0: c0, currency1: c1, fee: pp.fee, tickSpacing: pp.tickSpacing, hooks: GPUHook(d.hook)});
        bool gIsC0 = Currency.unwrap(c0) == d.gusd;
        // sqrtRatio = sqrt(gUSD-wei per GPU-wei) * 2^96 from the live oracle;
        // when the ordering flips, invert: 2^192 / sqrtRatio == sqrt(1/ratio) * 2^96
        uint256 sqrtRatio = GPUIssuance(d.issuance).oracleSqrtPriceX96(gpuId);
        uint160 initSqrt = gIsC0 ? uint160((uint256(1) << 192) / sqrtRatio) : uint160(sqrtRatio);
        PoolId poolId = key.toId();
        PoolManager(d.poolManager).initialize(key, initSqrt);
        require(GPUHook(d.hook).poolGpuId(poolId) == gpuId, "pool not registered");
    }

    function _persist(Deployment memory d, bool oracleDeployed) internal {
        string memory json = "deployment";
        vm.serializeAddress(json, "usdc", d.usdc);
        vm.serializeAddress(json, "poolManager", d.poolManager);
        vm.serializeAddress(json, "stateView", d.stateView);
        vm.serializeAddress(json, "gusd", d.gusd);
        vm.serializeAddress(json, "sgusd", d.sgusd);
        vm.serializeAddress(json, "ledger", d.ledger);
        vm.serializeAddress(json, "issuance", d.issuance);
        vm.serializeAddress(json, "oracle", d.oracle);
        if (oracleDeployed) {
            // the publication identity ops must fund and keep hot; only present
            // when we deployed the oracle (external ORACLE keeps today's shape)
            vm.serializeAddress(json, "oraclePublisher", GPUPriceOracle(d.oracle).publisher());
        }
        vm.serializeAddress(json, "hook", d.hook);
        vm.serializeAddress(json, "router", d.router);
        vm.serializeAddress(json, "permit2", d.permit2);
        vm.serializeAddress(json, "positionManager", d.positionManager);
        vm.serializeAddress(json, "quoter", d.quoter);
        vm.serializeAddress(json, "weth", d.weth);
        string memory out = vm.serializeUint(json, "chainId", block.chainid);
        vm.writeJson(out, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
    }
}
