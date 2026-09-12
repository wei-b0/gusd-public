// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
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
import {GPUMarketLiquidity} from "../src/GPUMarketLiquidity.sol";
import {GPUHook} from "../src/hooks/GPUHook.sol";
import {GpuRouter} from "../src/GpuRouter.sol";
import {GpuQuoter} from "../src/lens/GpuQuoter.sol";
import {StableRouter} from "../src/StableRouter.sol";
import {GPUPriceOracle} from "../src/oracle/GPUPriceOracle.sol";
import {IGPUPriceOracle} from "../src/oracle/IGPUPriceOracle.sol";
import {IGPUIssuance} from "../src/interfaces/IGPUIssuance.sol";
import {GpuPoolKey} from "../src/libraries/GpuPoolKey.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HookMiner} from "v4-periphery-test/shared/HookMiner.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HookMiner} from "v4-periphery-test/shared/HookMiner.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// @notice Chain-agnostic deployment of the V2 protocol stack: core primitives,
///         the 0x10CC trading-fee hook, the BUY/SELL product router, and the
///         production periphery (Permit2/WETH/Descriptor/PositionManager/Quoter)
///         that external LPs provision the canonical pools through.
///         The TestnetOnly base supplies the mainnet predicate only: on a
///         production chain this script refuses its dev postures (mock
///         reserve, fixture seed prices) — see docs/mainnet-deploy.md.
contract Deploy is Script, TestnetOnly {
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

    // PROTOCOL.md §3 launch catalogue — the four tokenized/settled GPUs. Ids
    // are bytes32 left-aligned ASCII SKUs. Seed prices are oracle seeds in
    // PRICE_SCALE fixed point (×10_000, so 25_000 = $2.50/GPU-hour): H100/H200
    // anchor to live market rates; L40S/RTX 4090 are stylized dev/test
    // fixtures, not oracle truth — the first real publication replaces them.
    // Production deploys set every seed explicitly via SEED_PRICE_<SYMBOL>
    // (see _seedPrice): the seed is the reference all early fills price
    // against until the pipeline's first publication clears its trigger.
    bytes32 public constant H100_ID = bytes32(bytes("H100_SXM_80GB"));
    bytes32 public constant H200_ID = bytes32(bytes("H200_141GB"));
    bytes32 public constant L40S_ID = bytes32(bytes("L40S_48GB"));
    bytes32 public constant RTX_4090_ID = bytes32(bytes("RTX_4090_24GB"));

    struct GpuCatalogEntry {
        bytes32 id;
        string name;
        string symbol;
        uint256 seedPrice;
    }

    function gpuCatalogue() internal view returns (GpuCatalogEntry[] memory e) {
        e = new GpuCatalogEntry[](4);
        e[0] = GpuCatalogEntry(H100_ID, "H100 SXM 80GB GPU-hour", "H100", _seedPrice("H100", 25_000)); // $2.50
        e[1] = GpuCatalogEntry(H200_ID, "H200 141GB GPU-hour", "H200", _seedPrice("H200", 32_000)); // $3.20
        e[2] = GpuCatalogEntry(L40S_ID, "L40S 48GB GPU-hour", "L40S", _seedPrice("L40S", 6_000)); // $0.60 — dev fixture
        e[3] = GpuCatalogEntry(RTX_4090_ID, "RTX 4090 24GB GPU-hour", "RTX4090", _seedPrice("RTX4090", 3_000)); // $0.30 — dev fixture
    }

    /// @dev One launch seed, env-overridable per SKU: SEED_PRICE_H100 /
    ///      H200 / L40S / RTX4090 (PRICE_SCALE ×10_000, so 25_000 = $2.50).
    ///      Dev defaults are the §3 table above; a production deploy sets
    ///      each from the collector pipeline's live snapshot at deploy time —
    ///      real capital must never price against a fabricated fixture until
    ///      the pipeline's first publication replaces it.
    function _seedPrice(string memory symbol, uint256 devPrice) internal view returns (uint256) {
        return vm.envOr(string.concat("SEED_PRICE_", symbol), uint256(devPrice));
    }

    struct Deployment {
        address underlying;
        address poolManager;
        address stateView;
        address gusd;
        address sgusd;
        address ledger;
        address marketLiquidity;
        address issuance;
        address oracle;
        address hook;
        address router;
        address stableRouter;
        address[] stables;
        address permit2;
        address positionManager;
        address quoter;
        address gpuQuoter;
        address weth;
        uint256 chainId;
    }

    function run() external returns (Deployment memory d) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        // Pre-broadcast posture guard: on a production chain the reserve
        // asset and every launch seed are real. A forgotten UNDERLYING or a
        // missing SEED_PRICE_* fails loudly BEFORE the first transaction is
        // sent — the mock reserve and the fixture seeds are dev hermeticity,
        // never postures that touch real capital (docs/mainnet-deploy.md).
        if (_isMainnet()) {
            require(
                vm.envOr("UNDERLYING", address(0)) != address(0),
                "mainnet requires a real UNDERLYING (no mock reserve on mainnet)"
            );
            require(vm.envOr("SEED_PRICE_H100", uint256(0)) != 0, "mainnet requires SEED_PRICE_H100");
            require(vm.envOr("SEED_PRICE_H200", uint256(0)) != 0, "mainnet requires SEED_PRICE_H200");
            require(vm.envOr("SEED_PRICE_L40S", uint256(0)) != 0, "mainnet requires SEED_PRICE_L40S");
            require(vm.envOr("SEED_PRICE_RTX4090", uint256(0)) != 0, "mainnet requires SEED_PRICE_RTX4090");
        }
        vm.startBroadcast(pk);

        // 1) underlying + oracle (env overrides for real assets). The reserve
        //    asset is per-chain: USDG on Robinhood Chain, USDC where USDC is
        //    canonical. A mock fallback keeps dev/test deploys hermetic; its
        //    name/symbol are env-driven and default to USDG's identity so the
        //    dev preview shows the Robinhood Chain posture without pretending
        //    to be the real asset.
        address underlyingEnv = vm.envOr("UNDERLYING", address(0));
        address oracleEnv = vm.envOr("ORACLE", address(0));
        bool underlyingIsMock;
        bool oracleDeployed;
        if (underlyingEnv != address(0)) {
            d.underlying = underlyingEnv;
        } else {
            string memory name = vm.envOr("UNDERLYING_NAME", string("Global Dollar"));
            string memory symbol = vm.envOr("UNDERLYING_SYMBOL", string("USDG"));
            MockERC20 u = new MockERC20(name, symbol, 6);
            d.underlying = address(u);
            underlyingIsMock = true;
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

        // 2) v4 core + production periphery (LP surface + offchain quoting).
        //    On chains with a canonical v4 stack (e.g. Robinhood mainnet),
        //    POOL_MANAGER + STATE_VIEW + QUOTER reuse it verbatim so liquidity
        //    is not fragmented across a second manager; POSITION_MANAGER and
        //    WETH stay optional overrides. Unset (default) deploys everything
        //    fresh — Anvil and empty testnets.
        address pmEnv = vm.envOr("POOL_MANAGER", address(0));
        address svEnv = vm.envOr("STATE_VIEW", address(0));
        address quoterEnv = vm.envOr("QUOTER", address(0));
        address pmgrEnv = vm.envOr("POSITION_MANAGER", address(0));
        address wethEnv = vm.envOr("WETH", address(0));
        if (pmEnv != address(0)) {
            require(svEnv != address(0) && quoterEnv != address(0), "external POOL_MANAGER requires STATE_VIEW + QUOTER");
            d.poolManager = pmEnv;
            d.stateView = svEnv;
            d.quoter = quoterEnv;
        } else {
            d.poolManager = address(new PoolManager(deployer));
            d.stateView = address(new StateView(IPoolManager(d.poolManager)));
            d.quoter = address(new V4Quoter(IPoolManager(d.poolManager)));
        }
        d.permit2 = _ensurePermit2();
        d.weth = wethEnv != address(0) ? wethEnv : address(new WETH());
        d.positionManager = pmgrEnv != address(0)
            ? pmgrEnv
            : address(
                new PositionManager(
                    IPoolManager(d.poolManager),
                    IAllowanceTransfer(d.permit2),
                    100_000, // unsubscribeGasLimit
                    new PositionDescriptor(IPoolManager(d.poolManager), d.weth, "ETH"),
                    IWETH9(d.weth)
                )
            );

        // 3) protocol primitives. Deploy order breaks the POL <-> issuance
        //    construction cycle: PoolManager -> gusd/ledger -> POL -> issuance
        //    -> hook -> POL.setRefs (one-shot, owner-gated).
        d.gusd = address(new GUSD(IERC20(d.underlying), deployer));
        d.sgusd = address(new sgUSD(IERC20(d.gusd), deployer));
        d.ledger = address(new RevenueLedger(IERC20(d.gusd), deployer));
        d.marketLiquidity = address(new GPUMarketLiquidity(IERC20(d.gusd), d.poolManager, deployer));
        d.issuance = address(
            new GPUIssuance(IERC20(d.gusd), IGPUPriceOracle(d.oracle), d.ledger, d.marketLiquidity, deployer)
        );

        // 4) mine + deploy the 0x10CC hook against the CREATE2 proxy
        bytes memory ctorArgs =
            abi.encode(IPoolManager(d.poolManager), d.gusd, IGPUPriceOracle(d.oracle), GPUIssuance(d.issuance), d.ledger, deployer);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(CREATE2_PROXY, HOOK_FLAGS, type(GPUHook).creationCode, ctorArgs);
        d.hook = address(
            new GPUHook{salt: salt}(
                IPoolManager(d.poolManager), d.gusd, IGPUPriceOracle(d.oracle), GPUIssuance(d.issuance), d.ledger, deployer
            )
        );
        require(d.hook == hookAddr, "hook address mismatch");
        GPUMarketLiquidity(d.marketLiquidity).setRefs(d.issuance, d.hook);

        // 5) product router
        d.router = address(
            new GpuRouter(IPoolManager(d.poolManager), GUSD(d.gusd), GPUIssuance(d.issuance), GPUHook(d.hook))
        );

        // 5.4) executable-quote lens: runs the REAL hook inside a PoolManager
        //      lock against a private float (revert-borne results). Floats are
        //      funded by Deploy.full (buys consume gUSD float; sells GPU float).
        d.gpuQuoter = address(new GpuQuoter(IPoolManager(d.poolManager), d.gusd, GPUIssuance(d.issuance), deployer));

        // 5.5) stable funding router: whitelisted stables -> underlying ->
        //      gUSD. The underlying is whitelisted at construction; STABLES
        //      adds extra funding assets (comma-separated, config-trust only —
        //      never derived from token symbols). Pools are caller-supplied
        //      per flow; LPs provision them through the PositionManager.
        d.stableRouter = address(new StableRouter(IPoolManager(d.poolManager), GUSD(d.gusd), deployer));
        string memory stablesCsv = vm.envOr("STABLES", string(""));
        if (bytes(stablesCsv).length > 0) {
            string[] memory parts = vm.split(stablesCsv, ",");
            for (uint256 i; i < parts.length; ++i) {
                address s = vm.parseAddress(parts[i]);
                StableRouter(d.stableRouter).setStable(s, true);
            }
        }
        d.stables = StableRouter(d.stableRouter).allStables();

        // 6) wiring — no protocolFeeController: the hook captures the protocol
        //    trading share itself (gUSD-denominated in both directions)
        GUSD(d.gusd).setRevenueSink(d.ledger);
        GUSD(d.gusd).setFees(50, 50); // USD↔gUSD corridor: 50 bps mint + redeem
        RevenueLedger(d.ledger).setVault(d.sgusd);
        RevenueLedger(d.ledger).setTreasury(vm.envOr("TREASURY", deployer));
        RevenueLedger(d.ledger).setSplit(5_000);
        GPUHook(d.hook).setHookFeeBps(50);
        // seed the sgUSD vault: 1 gUSD in, 1 share out (one-way gate). A mock
        // reserve funds itself; a real external asset must already sit on the
        // deployer (≥ the gross below) — there is no mint to call on it. The
        // gross covers the GUSD mint fee so the net lands at exactly 1 gUSD.
        uint256 mintFeeBps = GUSD(d.gusd).mintFeeBps();
        uint256 seedGross = Math.mulDiv(1e6, 10_000, 10_000 - mintFeeBps, Math.Rounding.Ceil) + 1;
        if (underlyingIsMock) MockERC20(d.underlying).mint(deployer, seedGross);
        else require(IERC20(d.underlying).balanceOf(deployer) >= seedGross, "deployer must hold the seed gross of UNDERLYING to seed sgUSD");
        IERC20(d.underlying).approve(d.gusd, seedGross);
        GUSD(d.gusd).mint(seedGross, deployer);
        require(IERC20(d.gusd).balanceOf(deployer) >= 1e6, "seed net below 1 gUSD");
        GUSD(d.gusd).approve(d.sgusd, 1e6);
        sgUSD(d.sgusd).seed(1e6);
        require(uint160(d.hook) & Hooks.ALL_HOOK_MASK == HOOK_FLAGS, "hook flags mismatch");

        // 7) canonical GPU universe: register the launch four, enable issuance,
        //    seed the oracle prices, and initialize the canonical (empty)
        //    pools so every market is live at deploy time; genesis BUYs are
        //    100% issuance until LPs add depth through the PositionManager.
        GpuCatalogEntry[] memory catalogue = gpuCatalogue();
        for (uint256 i; i < catalogue.length; ++i) {
            bytes32 gpuId = catalogue[i].id;
            GPUIssuance(d.issuance).createGpu(
                gpuId, catalogue[i].name, catalogue[i].symbol, 50, 3000, 60
            );
            GPUIssuance(d.issuance).setIssuanceEnabled(gpuId, true);
            if (oracleDeployed) {
                // genesis seed via the owner hatch: works for any PUBLISHER
                // value, including a publisher key the deployer does not
                // control
                GPUPriceOracle(d.oracle).setPriceOverride(
                    gpuId, catalogue[i].seedPrice, block.timestamp
                );
            }
            // POL market-making params (ask/bid spread + POL fee, bps) —
            // without them effAsk is 0 and the in-swap backstop's fee has no
            // headroom: every dry-book buy reverts InsufficientMarketCapacity.
            GPUHook(d.hook).setPolParams(gpuId, 50, 50, 10);
            // derives the pool's starting price from the live oracle: an
            // external oracle must have published (fail closed — the pool
            // refuses to start at a fabricated price)
            _initializeCanonicalPool(d, gpuId);
        }
        if (!oracleDeployed) {
            console2.log("oracle external; pools initialize at the oracle's live price");
        }

        vm.stopBroadcast();
        _persist(d, oracleDeployed);
        console2.log("gusd", d.gusd);
        console2.log("hook", d.hook);
        console2.log("router", d.router);
        console2.log("stableRouter", d.stableRouter);
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
        PoolKey memory key = GpuPoolKey.canonical(d.gusd, gpuToken, pp, GPUHook(d.hook));
        bool gIsC0 = GpuPoolKey.gusdIsCurrency0(key, d.gusd);
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
        vm.serializeAddress(json, "underlying", d.underlying);
        vm.serializeAddress(json, "stableRouter", d.stableRouter);
        vm.serializeAddress(json, "stables", d.stables);
        vm.serializeAddress(json, "poolManager", d.poolManager);
        vm.serializeAddress(json, "stateView", d.stateView);
        vm.serializeAddress(json, "gusd", d.gusd);
        vm.serializeAddress(json, "sgusd", d.sgusd);
        vm.serializeAddress(json, "ledger", d.ledger);
        vm.serializeAddress(json, "marketLiquidity", d.marketLiquidity);
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
        vm.serializeAddress(json, "gpuQuoter", d.gpuQuoter);
        vm.serializeAddress(json, "weth", d.weth);
        string memory out = vm.serializeUint(json, "chainId", block.chainid);
        // Indexer anchor: the simulation runs at the pre-broadcast block, so
        // every deployment event lands AFTER this — and startBlock may
        // overlap empty blocks harmlessly, but never skip an event.
        // serializeUint's return is the updated serialization; the discarded
        // return here silently dropped the key from the written file.
        out = vm.serializeUint(json, "startBlock", block.number > 0 ? block.number - 1 : 0);
        vm.writeJson(out, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
    }
}
