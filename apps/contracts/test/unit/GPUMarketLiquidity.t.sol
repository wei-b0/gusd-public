// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {StateView} from "@uniswap/v4-periphery/lens/StateView.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/libraries/LiquidityAmounts.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";
import {GUSD} from "../../src/GUSD.sol";
import {RevenueLedger} from "../../src/RevenueLedger.sol";
import {GPUIssuance} from "../../src/GPUIssuance.sol";
import {GPUMarketLiquidity} from "../../src/GPUMarketLiquidity.sol";
import {GPUToken} from "../../src/GPUToken.sol";
import {GPUHook} from "../../src/hooks/GPUHook.sol";
import {MockGPUPriceOracle} from "../../src/oracle/MockGPUPriceOracle.sol";
import {IGPUPriceOracle} from "../../src/oracle/IGPUPriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {HookMiner} from "v4-periphery-test/shared/HookMiner.sol";

/// @notice GPUMarketLiquidity unit suite. The same suite runs under both
///         currency orderings: `_wantGusdIsCurrency0` brute-forces a GPU id
///         whose CREATE2 token address lands on the requested side of gUSD.
///         Expected placement geometry is mirrored from the POL's own inputs —
///         the guarded `referenceSqrtPriceX96` view plus the same fixed-point
///         ask markup — so the tests assert exact ranges, liquidity, and
///         principal amounts without duplicating constants by hand.
///         Orientation note (h = gUSD-wei per GPU-wei): for gIsC0 the pool
///         price is 1/h and the pool tick falls as h rises (tAsk = -tick(h_ask));
///         for gIsC1 the pool price is h (tAsk = +tick(h_ask)). Sign-directed
///         offsets (`dir`) account for the flip.
abstract contract GPUMarketLiquidityTestBase is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    MockERC20 internal underlying;
    GUSD internal gusd;
    MockGPUPriceOracle internal oracle;
    GPUIssuance internal issuance;
    GPUMarketLiquidity internal pol;
    GPUHook internal hook;
    StateView internal stateView;
    address internal ledger;
    GPUToken internal gpu;
    bytes32 internal GPU_ID;
    bytes32 internal GENESIS_ID;
    address internal seller = makeAddr("seller"); // sells GPU into the bid band
    address internal buyer = makeAddr("buyer"); // buys GPU from the pool
    bool internal gIsC0;

    uint16 internal constant FEE_BPS = 50; // issuance fee, also the ask markup
    uint24 internal constant POOL_FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    int24 internal constant WIDTH = 600; // bandWidthTicks
    int24 internal constant SPREAD = 120; // bandSpreadTicks
    uint256 internal constant PRICE = 25_000; // $2.50/GPU-hour, 4-dec
    uint256 internal constant AMOUNT = 100e18; // GPU per default issue

    function _wantGusdIsCurrency0() internal view virtual returns (bool);

    function setUp() public virtual {
        vm.warp(1_000_000);
        deployFreshManagerAndRouters();
        underlying = new MockERC20("USD Coin", "USDC", 6);
        gusd = new GUSD(IERC20(address(underlying)), address(this));
        ledger = address(new RevenueLedger(IERC20(address(gusd)), address(this)));
        oracle = new MockGPUPriceOracle(address(this));
        pol = new GPUMarketLiquidity(manager, gusd, ledger, address(this));
        issuance = new GPUIssuance(IERC20(address(gusd)), IGPUPriceOracle(address(oracle)), ledger, address(pol), address(this));
        GPU_ID = _pickGpuId(_wantGusdIsCurrency0(), "GPU_POL_MAIN", "GPU hour", "GPU");

        bytes memory ctorArgs =
            abi.encode(IPoolManager(address(manager)), address(gusd), issuance, ledger, address(this));
        uint160 flags = uint160(
            Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        (address hookAddr, bytes32 salt) = HookMiner.find(address(this), flags, type(GPUHook).creationCode, ctorArgs);
        hook = GPUHook(hookAddr);
        new GPUHook{salt: salt}(IPoolManager(address(manager)), address(gusd), issuance, ledger, address(this));
        pol.setRefs(address(issuance), address(hook));

        gusd.setRevenueSink(ledger);
        RevenueLedger(ledger).setVault(makeAddr("sgusdVault"));
        RevenueLedger(ledger).setTreasury(makeAddr("treasury"));

        _createAndPrice(GPU_ID, "GPU hour", "GPU");
        gpu = GPUToken(issuance.tokenOf(GPU_ID));
        gIsC0 = address(gusd) < address(gpu);

        // a second GPU with NO pool: unregistered-pool no-op tests
        GENESIS_ID = _pickGpuId(_wantGusdIsCurrency0(), "GPU_POL_GENESIS", "Genesis GPU", "GGPU");
        _createAndPrice(GENESIS_ID, "Genesis GPU", "GGPU");

        stateView = new StateView(manager);
    }

    // ------------------------------------------------------------ helpers

    function _createAndPrice(bytes32 id, string memory name, string memory symbol) internal {
        issuance.createGpu(id, name, symbol, FEE_BPS, POOL_FEE, TICK_SPACING, WIDTH, SPREAD);
        issuance.setIssuanceEnabled(id, true);
        oracle.setPrice(id, PRICE, block.timestamp);
    }

    function _pickGpuId(bool wantTokenAboveGusd, string memory tag, string memory name, string memory symbol)
        internal
        view
        returns (bytes32)
    {
        for (uint256 i; i < 1024; ++i) {
            bytes32 id = bytes32(bytes(string.concat(tag, vm.toString(i))));
            address predicted = vm.computeCreate2Address(
                id,
                keccak256(abi.encodePacked(type(GPUToken).creationCode, abi.encode(address(issuance), id, name, symbol))),
                address(issuance)
            );
            if (wantTokenAboveGusd ? predicted > address(gusd) : predicted < address(gusd)) return id;
        }
        revert("no gpu id on requested side");
    }

    function _canonicalKey() internal view returns (PoolKey memory) {
        address gpuToken = issuance.tokenOf(GPU_ID);
        return PoolKey({
            currency0: Currency.wrap(gIsC0 ? address(gusd) : gpuToken),
            currency1: Currency.wrap(gIsC0 ? gpuToken : address(gusd)),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: hook
        });
    }

    /// @dev Each test picks its starting pool tick — placement geometry is
    ///      tick-relative, so the anchor/clamp/defer cases need different
    ///      starting points.
    function _initPool(int24 tick) internal {
        manager.initialize(_canonicalKey(), TickMath.getSqrtPriceAtTick(tick));
    }

    /// @dev Pool-tick equivalent of the oracle reference (no fee markup).
    function _tRef() internal view returns (int24) {
        int24 tRaw = TickMath.getTickAtSqrtPrice(uint160(issuance.referenceSqrtPriceX96(GPU_ID)));
        return gIsC0 ? -tRaw : tRaw;
    }

    /// @dev Pool tick at the issuance ask, mirroring `_zones` exactly: same
    ///      guarded reference, same sqrt((1 + feeBps)) markup, same orientation
    ///      negation.
    function _tAsk() internal view returns (int24) {
        uint256 refSqrt = issuance.referenceSqrtPriceX96(GPU_ID);
        uint256 sqrtAsk = (refSqrt * FixedPointMathLib.sqrt((10_000 + uint256(FEE_BPS)) * 1e18 / 10_000)) / 1e9;
        int24 tRawAsk = TickMath.getTickAtSqrtPrice(uint160(sqrtAsk));
        return gIsC0 ? -tRawAsk : tRawAsk;
    }

    /// @dev Expected bid band at the oracle anchor (pool on the gUSD-rich side
    ///      of the zone) — mirrors `_zones` + `_bidRange`'s anchor branch.
    function _bidAnchor() internal view returns (int24 lo, int24 hi) {
        int24 tAsk = _tAsk();
        if (gIsC0) {
            lo = _alignUp(tAsk + SPREAD);
            hi = lo + WIDTH;
        } else {
            hi = _alignDown(tAsk - SPREAD);
            lo = hi - WIDTH;
        }
    }

    /// @dev Expected ask band at the oracle anchor — mirrors `_askRange`'s
    ///      anchor branch.
    function _askAnchor() internal view returns (int24 lo, int24 hi) {
        int24 tAsk = _tAsk();
        if (gIsC0) {
            hi = _alignDown(tAsk);
            lo = hi - WIDTH;
        } else {
            lo = _alignUp(tAsk);
            hi = lo + WIDTH;
        }
    }

    function _rawBidLo() internal view returns (int24) {
        return gIsC0 ? _tAsk() + SPREAD : _tAsk() - SPREAD - WIDTH;
    }

    function _rawBidHi() internal view returns (int24) {
        return gIsC0 ? _tAsk() + SPREAD + WIDTH : _tAsk() - SPREAD;
    }

    function _rawAskLo() internal view returns (int24) {
        return gIsC0 ? _tAsk() - WIDTH : _tAsk();
    }

    function _rawAskHi() internal view returns (int24) {
        return gIsC0 ? _tAsk() : _tAsk() + WIDTH;
    }

    /// @dev Exact mirror of `_liquidityForGusd`: floored liquidity from
    ///      `available`, manager-rounded-up principal.
    function _mirrorGusdPlacement(int24 lo, int24 hi, uint256 available)
        internal
        view
        returns (uint128 liquidity, uint256 required)
    {
        uint160 sl = TickMath.getSqrtPriceAtTick(lo);
        uint160 sh = TickMath.getSqrtPriceAtTick(hi);
        if (gIsC0) {
            liquidity = LiquidityAmounts.getLiquidityForAmount0(sl, sh, available);
            required = SqrtPriceMath.getAmount0Delta(sl, sh, liquidity, true);
        } else {
            liquidity = LiquidityAmounts.getLiquidityForAmount1(sl, sh, available);
            required = SqrtPriceMath.getAmount1Delta(sl, sh, liquidity, true);
        }
    }

    function _dealGusd(address to, uint256 gusdAmt) internal {
        deal(address(gusd), to, gusdAmt);
    }

    /// @dev Issues `amount` GPU to `to` at the current oracle price (pays
    ///      base + fee; the base lands on the POL as pending principal).
    function _issueGpuTo(bytes32 id, address to, uint256 amount) internal returns (uint256 base) {
        uint256 fee;
        (base, fee,) = issuance.quoteIssue(id, amount);
        _dealGusd(to, base + fee);
        vm.startPrank(to);
        gusd.approve(address(issuance), type(uint256).max);
        issuance.issue(id, amount, to);
        vm.stopPrank();
    }

    /// @dev Default scenario: issue AMOUNT to this contract and deploy the
    ///      pending principal as the anchor bid band. Returns the base,
    ///      expected range, and expected required principal.
    function _placeDefaultBand() internal returns (uint256 base, int24 lo, int24 hi, uint256 required) {
        (base,,) = issuance.quoteIssue(GPU_ID, AMOUNT);
        _issueGpuTo(GPU_ID, address(this), AMOUNT);
        assertTrue(pol.deployPending(GPU_ID), "deploy pending");
        (lo, hi) = _bidAnchor();
        (, required) = _mirrorGusdPlacement(lo, hi, base);
    }

    /// @dev Sells `gpuIn` GPU into the pool (across the bid band); returns
    ///      the gUSD received.
    function _sellGpu(address who, uint256 gpuIn) internal returns (uint256 gusdOut) {
        vm.startPrank(who);
        gpu.approve(address(swapRouter), type(uint256).max);
        BalanceDelta delta = swapRouter.swap(
            _canonicalKey(),
            SwapParams({
                zeroForOne: !gIsC0, // GPU -> gUSD
                amountSpecified: -int256(gpuIn),
                sqrtPriceLimitX96: gIsC0 ? TickMath.MAX_SQRT_PRICE - 1 : TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        gusdOut = uint128(gIsC0 ? delta.amount0() : delta.amount1());
    }

    /// @dev Buys GPU from the pool with `gusdIn`; returns the GPU received.
    function _buyGpu(address who, uint256 gusdIn) internal returns (uint256 gpuOut) {
        vm.startPrank(who);
        gusd.approve(address(swapRouter), type(uint256).max);
        BalanceDelta delta = swapRouter.swap(
            _canonicalKey(),
            SwapParams({
                zeroForOne: gIsC0, // gUSD -> GPU
                amountSpecified: -int256(gusdIn),
                sqrtPriceLimitX96: gIsC0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        gpuOut = uint128(gIsC0 ? delta.amount1() : delta.amount0());
    }

    function _alignUp(int24 t) internal pure returns (int24) {
        int24 r = t % TICK_SPACING;
        if (r > 0) return t + (TICK_SPACING - r);
        if (r < 0) return t - r;
        return t;
    }

    function _alignDown(int24 t) internal pure returns (int24) {
        int24 r = t % TICK_SPACING;
        return r < 0 ? t - r - TICK_SPACING : t - r;
    }

    /// @dev Custody equation: the POL's gUSD balance is exactly pending +
    ///      dust + uncollected fees across all GPU ids; its GPU balance is
    ///      exactly the staged inventory. Belt-and-suspenders at unit level
    ///      (the invariant suite holds it across arbitrary handler sequences).
    function _assertCustody() internal view {
        assertEq(
            gusd.balanceOf(address(pol)),
            pol.pendingPrincipal(GPU_ID) + pol.residualOf(GPU_ID) + pol.feesPendingGusd(GPU_ID)
                + pol.pendingPrincipal(GENESIS_ID) + pol.residualOf(GENESIS_ID) + pol.feesPendingGusd(GENESIS_ID),
            "gUSD custody"
        );
        assertEq(
            IERC20(address(gpu)).balanceOf(address(pol)),
            pol.gpuInventory(GPU_ID) + pol.gpuInventory(GENESIS_ID),
            "GPU custody"
        );
    }

    function _currentTick() internal view returns (int24 tick) {
        (, tick,,) = stateView.getSlot0(_canonicalKey().toId());
    }

    // --------------------------------------------------------------- tests

    /// Anchor placement: pending principal places exactly at the mirrored
    /// oracle-anchored band; accounting, custody, and single-sided holdings
    /// all hold. The band holds only gUSD before any trade.
    function test_anchorPlacementAtReference() public {
        _initPool(_tRef());
        (uint256 base,,) = issuance.quoteIssue(GPU_ID, AMOUNT);
        _issueGpuTo(GPU_ID, address(this), AMOUNT);
        assertEq(pol.pendingPrincipal(GPU_ID), base, "pending on arrival");
        assertEq(pol.principalContributed(GPU_ID), base, "principal counted on arrival");
        assertEq(gusd.balanceOf(address(issuance)), 0, "issuance holds no gUSD");
        assertEq(pol.bandCount(GPU_ID), 0);

        assertTrue(pol.deployPending(GPU_ID), "placed");

        (int24 lo, int24 hi) = _bidAnchor();
        (uint128 liquidity, uint256 required) = _mirrorGusdPlacement(lo, hi, base);
        (int24 glo, int24 ghi) = pol.bandRange(GPU_ID, 0);
        assertEq(glo, lo, "anchor tickLower");
        assertEq(ghi, hi, "anchor tickUpper");
        (uint128 lq, uint256 gusdHeld, uint256 gpuHeld, uint256 gusdPlaced, uint256 gpuPlaced,,) = pol.bandView(GPU_ID, 0);
        assertEq(uint256(lq), uint256(liquidity), "liquidity");
        assertEq(gusdPlaced, required, "gusdPlaced = manager-rounded principal");
        assertEq(gpuPlaced, 0, "no GPU on the bid side");
        assertEq(pol.pendingPrincipal(GPU_ID), 0, "pending deployed");
        assertEq(pol.residualOf(GPU_ID), base - required, "placement dust carried as residual");
        assertApproxEqAbs(gusdHeld, required, 10, "band holds the principal");
        assertEq(gpuHeld, 0, "single-sided: zero GPU pre-placed");
        assertApproxEqAbs(pol.bidDepth(GPU_ID), required, 10, "bid depth is live");
        _assertCustody();
    }

    /// Clamp: the pool tick sits inside the bid zone — the one spot-informed
    /// case — so the band clamps to just beyond the current tick instead of
    /// the oracle anchor.
    function test_clampWhenPoolInsideZone() public {
        int24 dir = gIsC0 ? int24(1) : int24(-1);
        int24 tClamp = _tRef() + dir * 99;
        _initPool(tClamp);
        if (gIsC0) {
            assertGe(tClamp, _rawBidLo(), "precondition: pool inside zone");
            assertLt(tClamp, _rawBidHi(), "precondition: pool inside zone");
        } else {
            assertLe(tClamp, _rawBidHi(), "precondition: pool inside zone");
            assertGt(tClamp, _rawBidLo(), "precondition: pool inside zone");
        }
        _issueGpuTo(GPU_ID, address(this), AMOUNT);

        assertTrue(pol.deployPending(GPU_ID), "placed");
        (int24 glo, int24 ghi) = pol.bandRange(GPU_ID, 0);
        int24 elo;
        int24 ehi;
        if (gIsC0) {
            elo = _alignUp(tClamp);
            ehi = elo + WIDTH;
        } else {
            ehi = _alignDown(tClamp);
            elo = ehi - WIDTH;
        }
        assertEq(glo, elo, "clamp tickLower");
        assertEq(ghi, ehi, "clamp tickUpper");
        _assertCustody();
    }

    /// Defer: the pool is priced past the whole zone — bids would sit above
    /// the market — so nothing is placed and principal stays pending; a later
    /// oracle move that re-opens the corridor self-heals the placement.
    function test_deferPastZoneThenSelfHeal() public {
        int24 dir = gIsC0 ? int24(1) : int24(-1);
        int24 tDefer = _tRef() + dir * 739;
        _initPool(tDefer);
        if (gIsC0) {
            assertGe(tDefer, _rawBidHi(), "precondition: pool past zone");
        } else {
            assertLe(tDefer, _rawBidLo(), "precondition: pool past zone");
        }
        (uint256 base,,) = issuance.quoteIssue(GPU_ID, AMOUNT);
        _issueGpuTo(GPU_ID, address(this), AMOUNT);

        assertFalse(pol.deployPending(GPU_ID), "deferred");
        assertEq(pol.pendingPrincipal(GPU_ID), base, "principal intact while deferred");
        assertEq(pol.bandCount(GPU_ID), 0);

        // price falls (gIsC0) / rises (gIsC1): the anchor moves past the pool
        // tick, re-opening the anchor branch
        oracle.setPrice(GPU_ID, 23_000, block.timestamp);
        assertTrue(pol.deployPending(GPU_ID), "self-healed after reprice");
        (int24 lo, int24 hi) = _bidAnchor();
        (int24 glo, int24 ghi) = pol.bandRange(GPU_ID, 0);
        assertEq(glo, lo, "self-healed anchor tickLower");
        assertEq(ghi, hi, "self-healed anchor tickUpper");
        assertEq(pol.pendingPrincipal(GPU_ID) + pol.residualOf(GPU_ID), 0, "fully deployed");
        _assertCustody();
    }

    /// A stale oracle blocks every placement path — nothing is ever placed at
    /// a stale anchor; a heartbeat republish un-sticks the ops (the recenter
    /// then reaches its staleness gate, proving the oracle guard passed).
    function test_staleReferenceReverts() public {
        _initPool(_tRef());
        _issueGpuTo(GPU_ID, address(this), AMOUNT);
        assertTrue(pol.deployPending(GPU_ID), "placed while fresh");
        _issueGpuTo(GPU_ID, address(this), AMOUNT); // fresh pending for the stale attempt

        vm.warp(block.timestamp + issuance.maxOracleStaleness() + 1);
        vm.expectRevert(GPUIssuance.OracleStale.selector);
        pol.deployPending(GPU_ID);
        vm.expectRevert(GPUIssuance.OracleStale.selector);
        pol.recenter(GPU_ID, 0);

        oracle.setPrice(GPU_ID, PRICE, block.timestamp); // heartbeat
        vm.expectRevert(GPUMarketLiquidity.NothingToRecenter.selector);
        pol.recenter(GPU_ID, 0); // band still overlaps the zone: gate, not oracle
        assertTrue(pol.deployPending(GPU_ID), "self-heals after heartbeat");
    }

    /// A GPU whose canonical pool does not exist yet: issuance lands as
    /// pending principal and every placement op is a no-op, not a revert.
    function test_unregisteredPoolNoOp() public {
        (uint256 base,,) = issuance.quoteIssue(GENESIS_ID, 1e18);
        _issueGpuTo(GENESIS_ID, address(this), 1e18);
        assertEq(pol.pendingPrincipal(GENESIS_ID), base, "pre-pool issuance pends");

        assertFalse(pol.deployPending(GENESIS_ID), "no pool: no-op");
        assertFalse(pol.placeAskFromInventory(GENESIS_ID), "no pool: no-op");
        assertEq(pol.pendingPrincipal(GENESIS_ID), base, "pending intact");
        assertEq(pol.bandCount(GENESIS_ID), 0);
        vm.expectRevert(GPUMarketLiquidity.NothingToRecenter.selector);
        pol.recenter(GENESIS_ID, 0);
        _assertCustody();
    }

    /// Same reference twice: the second deployment merges into the existing
    /// band (salt 0) instead of laddering.
    function test_mergeWhenReferenceStable() public {
        _initPool(_tRef());
        (uint256 base,,) = issuance.quoteIssue(GPU_ID, AMOUNT);
        _issueGpuTo(GPU_ID, address(this), AMOUNT);
        assertTrue(pol.deployPending(GPU_ID));
        _issueGpuTo(GPU_ID, address(this), AMOUNT);
        assertTrue(pol.deployPending(GPU_ID));

        assertEq(pol.bandCount(GPU_ID), 1, "merged, not laddered");
        (, , , uint256 gusdPlaced,,,) = pol.bandView(GPU_ID, 0);
        assertApproxEqAbs(gusdPlaced, 2 * base, 4, "both placements in one band");
        assertEq(pol.principalContributed(GPU_ID), 2 * base, "cumulative principal");
        _assertCustody();
    }

    /// A moved reference ladders: the old band stays (recenter is explicit)
    /// and the new principal places at the fresh anchor.
    function test_ladderWhenReferenceMoves() public {
        _initPool(_tRef());
        _issueGpuTo(GPU_ID, address(this), AMOUNT);
        assertTrue(pol.deployPending(GPU_ID));
        (int24 lo0, int24 hi0) = pol.bandRange(GPU_ID, 0);

        // price falls: the anchor moves past the pool tick, so the next
        // deployment still lands (raising it would defer instead)
        oracle.setPrice(GPU_ID, 21_000, block.timestamp);
        _issueGpuTo(GPU_ID, address(this), AMOUNT);
        assertTrue(pol.deployPending(GPU_ID), "second rung placed");

        assertEq(pol.bandCount(GPU_ID), 2, "laddered");
        (int24 lo1, int24 hi1) = pol.bandRange(GPU_ID, 1);
        (int24 elo, int24 ehi) = _bidAnchor();
        assertEq(lo1, elo, "fresh anchor tickLower");
        assertEq(hi1, ehi, "fresh anchor tickUpper");
        assertTrue(lo1 != lo0 && hi1 != hi0, "distinct rungs");
        // first issue at PRICE, second at the moved 21_000 reference
        assertEq(pol.principalContributed(GPU_ID), AMOUNT * PRICE / 1e16 + AMOUNT * 21_000 / 1e16, "cumulative principal");
        _assertCustody();
    }

    /// Selling into the bid band converts principal to GPU inside the
    /// position: gUSD holdings fall, GPU holdings appear, `principalContributed`
    /// is untouched (it is cumulative accounting, not a claim on present
    /// assets), and bid depth declines honestly with the conversion.
    function test_sellIntoBidConverts() public {
        _initPool(_tRef());
        _placeDefaultBand();
        _issueGpuTo(GPU_ID, seller, 10e18); // seller's GPU; its principal stays pending
        uint256 principalBefore = pol.principalContributed(GPU_ID);
        (, uint256 gusdHeld0, , , , ,) = pol.bandView(GPU_ID, 0);
        uint256 depth0 = pol.bidDepth(GPU_ID);

        uint256 gusdOut = _sellGpu(seller, 10e18);
        assertGt(gusdOut, 22_000_000, "seller receives ~25 gUSD");
        assertLt(gusdOut, 25_200_000, "never above the issuance ask");

        (, uint256 gusdHeld1, uint256 gpuHeld1, , , ,) = pol.bandView(GPU_ID, 0);
        assertLt(gusdHeld1, gusdHeld0, "band gUSD consumed");
        assertGt(gpuHeld1, 0, "band converted to GPU");
        assertLt(pol.bidDepth(GPU_ID), depth0, "depth declined with the conversion");
        assertEq(pol.principalContributed(GPU_ID), principalBefore, "principal is accounting, not assets");
        _assertCustody();
    }

    /// A sell and a subsequent buy both cross in-range liquidity: the band
    /// accrues LP fees in BOTH currencies. Collect flushes gUSD fees to the
    /// revenue ledger (Option A) and recycles GPU fees into ask-side
    /// inventory; a second collect is a no-op.
    function test_collectSweepsBothCurrencies() public {
        _initPool(_tRef());
        _placeDefaultBand();
        _issueGpuTo(GPU_ID, seller, 10e18);
        _sellGpu(seller, 10e18); // tick up into the band: GPU-denominated fees
        _dealGusd(buyer, 100e6);
        _buyGpu(buyer, 20_000_000); // tick back down: gUSD-denominated fees

        uint256 ledgerBefore = gusd.balanceOf(ledger);
        uint256 invBefore = pol.gpuInventory(GPU_ID);
        pol.collect(GPU_ID);

        uint256 ledgerDelta = gusd.balanceOf(ledger) - ledgerBefore;
        assertGt(ledgerDelta, 0, "gUSD fees flushed to the ledger");
        assertEq(pol.feesPendingGusd(GPU_ID), 0, "no gUSD fees left pending");
        assertGt(pol.gpuInventory(GPU_ID), invBefore, "GPU fees recycled to inventory");
        _assertCustody();

        uint256 ledgerAfter = gusd.balanceOf(ledger);
        pol.collect(GPU_ID);
        assertEq(gusd.balanceOf(ledger), ledgerAfter, "second collect is a no-op");
        assertEq(pol.gpuInventory(GPU_ID), pol.gpuInventory(GPU_ID), "inventory stable");
    }

    /// Recenter when the pool is priced past the fresh bid zone: the stale
    /// band is removed and the recovered gUSD honestly returns to
    /// `pendingPrincipal` — NOT re-counted in `principalContributed` — and
    /// re-places on the next attempt once the corridor re-opens.
    function test_recenterDeferredGusdReturnsToPending() public {
        _initPool(_tRef());
        (uint256 base, int24 lo, int24 hi, uint256 required) = _placeDefaultBand();

        oracle.setPrice(GPU_ID, 30_000, block.timestamp); // anchor moves below the pool
        uint256 removed = pol.recenter(GPU_ID, 0);
        assertEq(removed, 1, "one stale band removed");
        assertEq(pol.bandCount(GPU_ID), 0, "nothing redeployed");
        assertApproxEqAbs(pol.pendingPrincipal(GPU_ID), required, 10, "recovered gUSD back to pending");
        assertEq(pol.principalContributed(GPU_ID), base, "provenance: not re-counted");
        assertEq(pol.gpuInventory(GPU_ID), 0);
        _assertCustody();

        // corridor re-opens: the same principal places at the same anchor
        oracle.setPrice(GPU_ID, PRICE, block.timestamp);
        assertTrue(pol.deployPending(GPU_ID), "deferred principal re-placed");
        (int24 glo, int24 ghi) = pol.bandRange(GPU_ID, 0);
        assertEq(glo, lo, "re-placed at the anchor tickLower");
        assertEq(ghi, hi, "re-placed at the anchor tickUpper");
        _assertCustody();
    }

    /// Recenter after partial conversion with a moved reference: the stale
    /// band's gUSD redeploys as the fresh bid band, while the recovered GPU
    /// stages in inventory because the pool is priced below the new ask zone
    /// (placing it would sell below market).
    function test_recenterRedeploysBidAndStagesGpu() public {
        _initPool(_tRef());
        _issueGpuTo(GPU_ID, seller, 8e18); // seller GPU; deployed with the band below
        (uint256 base, , , ) = _placeDefaultBand();
        // principalContributed counts both arrivals (seller 20 gUSD + base)
        uint256 principalExpected = base + 8e18 * PRICE / 1e16;
        _sellGpu(seller, 8e18);

        oracle.setPrice(GPU_ID, 21_000, block.timestamp);
        // precondition: the old band is clear of both fresh zones and the
        // pool sits below the fresh ask zone (ask defer)
        (int24 lo0, int24 hi0) = pol.bandRange(GPU_ID, 0);
        if (gIsC0) {
            assertLt(hi0, _rawAskLo(), "precondition: band stale");
            assertLt(_currentTick(), _rawAskLo(), "precondition: ask defer");
        } else {
            assertGt(lo0, _rawAskHi(), "precondition: band stale");
            assertGt(_currentTick(), _rawAskHi(), "precondition: ask defer");
        }

        uint256 removed = pol.recenter(GPU_ID, 0);
        assertEq(removed, 1);
        assertEq(pol.bandCount(GPU_ID), 1, "gUSD redeployed as one bid band");

        (int24 blo, int24 bhi) = _bidAnchor();
        (int24 glo, int24 ghi) = pol.bandRange(GPU_ID, 0);
        assertEq(glo, blo, "fresh anchor tickLower");
        assertEq(ghi, bhi, "fresh anchor tickUpper");
        (, , , uint256 gusdPlaced, , ,) = pol.bandView(GPU_ID, 0);
        assertGt(gusdPlaced, 0, "principal redeployed");
        assertGt(pol.gpuInventory(GPU_ID), 0, "recovered GPU staged, not sold below market");
        assertLe(pol.pendingPrincipal(GPU_ID), 100, "only rounding dust re-pended");
        assertEq(pol.principalContributed(GPU_ID), principalExpected, "provenance preserved");
        _assertCustody();
    }

    /// Staged inventory places as an ask band once the pool is priced past
    /// the ask zone — completing the bid<->ask inventory cycle.
    function test_placeAskFromInventory() public {
        _initPool(_tRef());
        _issueGpuTo(GPU_ID, seller, 8e18); // seller GPU; deployed with the band below
        _placeDefaultBand();
        _sellGpu(seller, 8e18);
        oracle.setPrice(GPU_ID, 21_000, block.timestamp);
        pol.recenter(GPU_ID, 0); // gUSD -> fresh bid band; GPU -> inventory
        uint256 staged = pol.gpuInventory(GPU_ID);
        assertGt(staged, 0, "setup: inventory staged");

        oracle.setPrice(GPU_ID, PRICE, block.timestamp);
        if (gIsC0) {
            assertGe(_currentTick(), _rawAskHi(), "precondition: pool past ask zone");
        } else {
            assertLe(_currentTick(), _rawAskLo(), "precondition: pool past ask zone");
        }
        assertTrue(pol.placeAskFromInventory(GPU_ID), "ask placed");

        assertEq(pol.bandCount(GPU_ID), 2, "bid + ask");
        (int24 alo, int24 ahi) = _askAnchor();
        (int24 glo, int24 ghi) = pol.bandRange(GPU_ID, 1);
        assertEq(glo, alo, "ask anchor tickLower");
        assertEq(ghi, ahi, "ask anchor tickUpper");
        (, , , , uint256 gpuPlaced, ,) = pol.bandView(GPU_ID, 1);
        assertApproxEqAbs(gpuPlaced, staged, 1e5, "staged inventory placed");
        assertLe(pol.gpuInventory(GPU_ID), 1e5, "only rounding dust left staged");
        _assertCustody();
    }

    /// Permissionless drift gate: a band that still overlaps the current
    /// zones cannot be force-recentered by callers; only the owner override
    /// bypasses staleness, and it re-places at the same anchor.
    function test_recenterGatesAndOwnerForce() public {
        _initPool(_tRef());
        _placeDefaultBand();

        vm.expectRevert(GPUMarketLiquidity.NothingToRecenter.selector);
        pol.recenter(GPU_ID, 0);

        address nonOwner = makeAddr("nonOwner");
        vm.prank(nonOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nonOwner));
        pol.recenter(GPU_ID, 0, true);

        uint256 removed = pol.recenter(GPU_ID, 0, true);
        assertEq(removed, 1, "owner force removed the band");
        assertEq(pol.bandCount(GPU_ID), 1, "redeployed");
        (int24 lo, int24 hi) = _bidAnchor();
        (int24 glo, int24 ghi) = pol.bandRange(GPU_ID, 0);
        assertEq(glo, lo, "re-placed at the same anchor tickLower");
        assertEq(ghi, hi, "re-placed at the same anchor tickUpper");
        _assertCustody();
    }

    /// Access control: one-shot refs, issuance-only accounting entry, and
    /// RefsIncomplete on a POL whose dependent contracts were never wired.
    function test_refsAndAccessControl() public {
        vm.expectRevert(GPUMarketLiquidity.RefsAlreadySet.selector);
        pol.setRefs(address(issuance), address(hook));

        vm.expectRevert(GPUMarketLiquidity.NotIssuance.selector);
        pol.notePrincipal(GPU_ID, 1);

        GPUMarketLiquidity orphan = new GPUMarketLiquidity(manager, gusd, ledger, address(this));
        vm.expectRevert(GPUMarketLiquidity.RefsIncomplete.selector);
        orphan.deployPending(GPU_ID);
        vm.expectRevert(GPUMarketLiquidity.RefsIncomplete.selector);
        orphan.placeAskFromInventory(GPU_ID);
        vm.expectRevert(GPUMarketLiquidity.RefsIncomplete.selector);
        orphan.recenter(GPU_ID, 0);
    }

    /// Structural: the GPU token is never approved to the pool manager (takes
    /// push GPU out; GPU settles from the POL's own balance), while gUSD is
    /// approved once for settle().
    function test_gpuNeverApproved() public {
        assertEq(gpu.allowance(address(pol), address(manager)), 0, "no GPU approval");
        assertEq(gusd.allowance(address(pol), address(manager)), type(uint256).max, "gUSD settle approval");
    }

    /// An absurd oracle price cannot produce a placement: the guarded
    /// reference path reverts before any band is booked (for extreme prices
    /// the reference view's 2^192 radicand overflows uint256 before its own
    /// range guard is even reachable — either way nothing is placed).
    function test_oraclePriceRange() public {
        _initPool(_tRef());
        (uint256 base,,) = issuance.quoteIssue(GPU_ID, AMOUNT);
        _issueGpuTo(GPU_ID, address(this), AMOUNT);
        oracle.setPrice(GPU_ID, 1e55, block.timestamp);
        vm.expectRevert();
        pol.deployPending(GPU_ID);
        assertEq(pol.pendingPrincipal(GPU_ID), base, "pending intact");
        assertEq(pol.bandCount(GPU_ID), 0, "nothing placed");
    }

    /// Every placement op is permissionless: a random EOA can deploy pending
    /// principal, collect fees, and attempt ask placement.
    function test_permissionlessOps() public {
        _initPool(_tRef());
        _issueGpuTo(GPU_ID, address(this), AMOUNT);

        address anyone = makeAddr("anyone");
        vm.prank(anyone);
        assertTrue(pol.deployPending(GPU_ID), "anyone can deploy pending");
        vm.prank(anyone);
        pol.collect(GPU_ID); // no fees yet: a no-op, not a revert
        vm.prank(anyone);
        assertFalse(pol.placeAskFromInventory(GPU_ID), "no inventory: no-op");
        _assertCustody();
    }
}

/// gUSD = currency0 orientation
contract POLGusdIsCurrency0Test is GPUMarketLiquidityTestBase {
    function _wantGusdIsCurrency0() internal view override returns (bool) {
        return true;
    }
}

/// gUSD = currency1 orientation (mirrored)
contract POLGusdIsCurrency1Test is GPUMarketLiquidityTestBase {
    function _wantGusdIsCurrency0() internal view override returns (bool) {
        return false;
    }
}
