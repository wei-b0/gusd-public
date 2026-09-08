// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {GUSD} from "../../src/GUSD.sol";
import {sgUSD} from "../../src/sgUSD.sol";
import {RevenueLedger} from "../../src/RevenueLedger.sol";
import {GPUIssuance} from "../../src/GPUIssuance.sol";
import {GPUMarketLiquidity} from "../../src/GPUMarketLiquidity.sol";
import {GPUToken} from "../../src/GPUToken.sol";
import {GPUHook} from "../../src/hooks/GPUHook.sol";
import {MockGPUPriceOracle} from "../../src/oracle/MockGPUPriceOracle.sol";
import {IGPUPriceOracle} from "../../src/oracle/IGPUPriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HookMiner} from "v4-periphery-test/shared/HookMiner.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {HandlerMintRedeem, HandlerIssuance, HandlerLiquidity, HandlerMarket, HandlerGovernance, IWorld, NotWorld} from "./Handlers.t.sol";

/// @notice The invariant world AND the IWorld facade the handlers call into.
contract InvariantTest is Test, Deployers, IWorld {
    GUSD internal s_gusd;
    sgUSD internal s_sg;
    RevenueLedger internal s_ledger;
    GPUIssuance internal s_issuance;
    GPUMarketLiquidity internal s_pol;
    GPUHook public hook;
    MockGPUPriceOracle internal s_oracle;
    GPUToken internal s_h100;
    MockERC20 internal s_usdc;

    address[] public actors;

    HandlerMintRedeem public hMintRedeem;
    HandlerIssuance public hIssuance;
    HandlerLiquidity public hLiquidity;
    HandlerMarket public hMarket;
    HandlerGovernance public hGov;

    bytes32 internal constant H100 = bytes32(bytes("H100_SXM_80GB"));
    uint160 constant HOOK_FLAGS = uint160(
        Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );
    // issuance ghosts: only the issuance handler may bump them (see recordIssuance)
    uint256 internal gMinted;
    uint256 internal gBase;
    uint256 internal gFee;
    // harvested hook trading fees: only the governance handler may bump it
    uint256 internal gHarvested;
    // POL LP fees flushed to the ledger: only the liquidity handler may bump it
    uint256 internal gPolCollected;
    uint256 internal initPrincipal;
    uint256 internal initGpuSupply;
    uint256 internal initLedgerReceived;

    constructor() {
        s_usdc = new MockERC20("USD Coin", "USDC", 6);
    }

    function setUp() public {
        vm.warp(1_000_000);
        deployFreshManagerAndRouters();
        s_gusd = new GUSD(IERC20(address(s_usdc)), address(this));
        s_sg = new sgUSD(IERC20(address(s_gusd)), address(this));
        s_ledger = new RevenueLedger(IERC20(address(s_gusd)), address(this));
        s_oracle = new MockGPUPriceOracle(address(this));
        s_pol = new GPUMarketLiquidity(manager, s_gusd, address(s_ledger), address(this));
        s_issuance = new GPUIssuance(
            IERC20(address(s_gusd)), IGPUPriceOracle(address(s_oracle)), address(s_ledger), address(s_pol), address(this)
        );
        bytes memory ctorArgs =
            abi.encode(IPoolManager(address(manager)), address(s_gusd), s_issuance, address(s_ledger), address(this));
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), HOOK_FLAGS, type(GPUHook).creationCode, ctorArgs);
        hook = GPUHook(hookAddr);
        new GPUHook{salt: salt}(
            IPoolManager(address(manager)), address(s_gusd), s_issuance, address(s_ledger), address(this)
        );
        s_pol.setRefs(address(s_issuance), address(hook));

        s_gusd.setRevenueSink(address(s_ledger));
        s_ledger.setVault(address(s_sg));
        s_ledger.setTreasury(makeAddr("treasury"));
        s_usdc.mint(address(this), 1e6);
        s_usdc.approve(address(s_gusd), type(uint256).max);
        s_gusd.mint(1e6, address(this));
        s_gusd.approve(address(s_sg), type(uint256).max);
        s_sg.seed(1e6);
        s_issuance.createGpu(H100, "H100 SXM 80GB GPU-hour", "H100", 50, 3000, 60, 600, 120);
        s_issuance.setIssuanceEnabled(H100, true);
        s_h100 = GPUToken(s_issuance.tokenOf(H100));
        s_oracle.setPrice(H100, 25_000, block.timestamp);

        for (uint256 i; i < 4; ++i) {
            actors.push(makeAddr(string.concat("actor", vm.toString(i))));
        }
        _initCanonicalPool();

        initPrincipal = s_pol.principalContributed(H100);
        initGpuSupply = s_h100.totalSupply();
        initLedgerReceived = s_ledger.totalToVault() + s_ledger.totalToTreasury() + s_gusd.balanceOf(address(s_ledger));
        hMintRedeem = new HandlerMintRedeem(IWorld(address(this)));
        hIssuance = new HandlerIssuance(IWorld(address(this)));
        hLiquidity = new HandlerLiquidity(IWorld(address(this)));
        hMarket = new HandlerMarket(IWorld(address(this)));
        hGov = new HandlerGovernance(IWorld(address(this)));

        targetContract(address(hMintRedeem));
        targetContract(address(hIssuance));
        targetContract(address(hLiquidity));
        targetContract(address(hMarket));
        targetContract(address(hGov));
    }

    function _initCanonicalPool() internal {
        s_usdc.mint(address(this), 20_000_000e6);
        s_gusd.mint(20_000_000e6, address(this));
        s_usdc.mint(actors[0], 10_000_000e6);
        vm.startPrank(actors[0]);
        s_usdc.approve(address(s_gusd), type(uint256).max);
        s_gusd.mint(10_000_000e6, actors[0]);
        s_gusd.approve(address(s_issuance), type(uint256).max);
        s_issuance.issue(H100, 200e18, actors[0]);
        vm.stopPrank();
        manager.initialize(poolKey(), TickMath.getSqrtPriceAtTick(-276325)); // ~2.5 gUSD/H100
        IERC20(address(s_gusd)).approve(address(modifyLiquidityRouter), type(uint256).max);
        IERC20(address(s_h100)).approve(address(modifyLiquidityRouter), type(uint256).max);
        vm.prank(actors[0]);
        s_h100.transfer(address(this), 100e18);
        modifyLiquidityRouter.modifyLiquidity(
            poolKey(), ModifyLiquidityParams({tickLower: -887220, tickUpper: 887220, liquidityDelta: 1e7, salt: 0}), ""
        );
    }

    function poolKey() public view override returns (PoolKey memory) {
        Currency c0 =
            address(s_h100) < address(s_gusd) ? Currency.wrap(address(s_h100)) : Currency.wrap(address(s_gusd));
        Currency c1 =
            address(s_h100) < address(s_gusd) ? Currency.wrap(address(s_gusd)) : Currency.wrap(address(s_h100));
        return PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: hook});
    }

    // IWorld facade passthroughs
    function underlying() external view override returns (address) {
        return address(s_usdc);
    }

    function gusd() external view override returns (address) {
        return address(s_gusd);
    }

    function issuance() external view override returns (address) {
        return address(s_issuance);
    }

    function h100() external view override returns (address) {
        return address(s_h100);
    }

    function ledger() external view override returns (address) {
        return address(s_ledger);
    }

    function oracle() external view override returns (address) {
        return address(s_oracle);
    }

    function swapRouterT() external view override returns (address) {
        return address(swapRouter);
    }

    function marketLiquidityT() external view override returns (address) {
        return address(s_pol);
    }

    function hookT() external view override returns (address) {
        return address(hook);
    }

    // --------------------------------------------------------- invariants

    /// @notice INVARIANT 1: gUSD exists only against eligible USDC (exact).
    function invariant_gusdReserveEqualsSupplyExactly() public view {
        assertEq(s_usdc.balanceOf(address(s_gusd)), s_gusd.totalSupply());
    }

    /// @notice INVARIANT 2: GPU supply grows only via authorized s_issuance.
    function invariant_gpuSupplyOnlyViaIssuance() public view {
        assertEq(s_h100.totalSupply(), initGpuSupply + gMinted);
        assertLe(s_h100.totalSupply(), 200e18 + 4 * 1000 * 1_000e18); // sanity bound
    }

    /// @notice INVARIANT 3: issuance flow conservation — every wei that enters
    ///         issue() is routed (base -> POL, fee -> ledger) and the contract
    ///         holds zero gUSD at rest.
    function invariant_issuanceHoldsNoGusd() public view {
        assertEq(s_gusd.balanceOf(address(s_issuance)), 0, "issuance holds gUSD");
    }

    /// @notice INVARIANT 4: principal accounting — the cumulative counter grows
    ///         exactly by recorded issuance bases and by nothing else.
    function invariant_principalAccounting() public view {
        assertEq(s_pol.principalContributed(H100), initPrincipal + gBase, "principal drifted");
        assertEq(s_pol.totalPrincipalContributed(), initPrincipal + gBase, "total drifted");
    }

    /// @notice INVARIANT 5: POL provenance — GPU supply grows only through
    ///         GPUIssuance's mint authority, so the POL can never mint (or
    ///         receive a paired mint of) GPU; its inventory originates only
    ///         from market swaps and LP fee accrual.
    function invariant_polNeverMintsGpu() public view {
        assertEq(s_h100.issuer(), address(s_issuance), "mint authority moved");
        assertTrue(address(s_pol) != address(s_h100.issuer()), "POL is the issuer");
    }

    /// @notice INVARIANT 6: POL custody — at rest every wei of the POL's gUSD
    ///         is exactly accounted: pending principal, placement dust, or
    ///         swept-but-uncollected fees. Structural: there is no withdrawal
    ///         path, so custody can only move through these entries.
    function invariant_polCustody() public view {
        assertEq(
            s_gusd.balanceOf(address(s_pol)),
            s_pol.pendingPrincipal(H100) + s_pol.residualOf(H100) + s_pol.feesPendingGusd(H100),
            "POL gUSD custody mismatch"
        );
        assertEq(IERC20(address(s_h100)).balanceOf(address(s_pol)), s_pol.gpuInventory(H100), "POL GPU custody mismatch");
    }

    /// @notice INVARIANT 7: no oracle-NAV redemption — oracle price changes
    ///         (the handler sets arbitrary prices) never alter the cumulative
    ///         principal accounting.
    function invariant_noNavRedemption() public view {
        assertEq(s_pol.principalContributed(H100), initPrincipal + gBase, "principal moved with price");
    }

    /// @notice Revenue conservation across the s_ledger: everything it ever
    ///         received (issuance fees + harvested hook trading fees) is still
    ///         either sitting in it or already distributed.
    function invariant_revenueConserved() public view {
        uint256 inLedger = s_gusd.balanceOf(address(s_ledger));
        assertEq(
            inLedger + s_ledger.totalToVault() + s_ledger.totalToTreasury(),
            initLedgerReceived + gFee + gHarvested + gPolCollected
        );
    }

    /// @notice INVARIANT 7: every wei of gUSD the hook holds is a tracked
    ///         trading fee — balance == accrued − harvested. gUSD only enters
    ///         via the hook's inside-swap take (exactly `fee` per accrual) and
    ///         leaves only via harvest (the tracked counter), so donations
    ///         can never inflate harvestable revenue.
    function invariant_hookFeeBalanceTrackedExactly() public view {
        assertEq(
            s_gusd.balanceOf(address(hook)),
            hook.totalTradingFeesAccrued() - hook.totalTradingFeesHarvested(),
            "hook balance != accrued - harvested"
        );
    }

    function recordIssuance(uint256 base, uint256 fee, uint256 minted) external override {
        if (msg.sender != address(hIssuance)) revert NotWorld();
        gBase += base;
        gFee += fee;
        gMinted += minted;
    }

    function recordHarvest(uint256 amount) external override {
        if (msg.sender != address(hGov)) revert NotWorld();
        gHarvested += amount;
    }

    function recordPolCollect(uint256 amount) external override {
        if (msg.sender != address(hLiquidity)) revert NotWorld();
        gPolCollected += amount;
    }

    // internal reset: the fuzzer can never reach this
    function afterInvariant() public {
        gMinted = 0;
        gBase = 0;
        gFee = 0;
        gHarvested = 0;
        gPolCollected = 0;
    }
}
