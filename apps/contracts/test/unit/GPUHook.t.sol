// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateView} from "@uniswap/v4-periphery/lens/StateView.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHookStats} from "@uniswap/v4-periphery/interfaces/external/IHookStats.sol";
import {GUSD} from "../../src/GUSD.sol";
import {RevenueLedger} from "../../src/RevenueLedger.sol";
import {GPUIssuance} from "../../src/GPUIssuance.sol";
import {GPUMarketLiquidity} from "../../src/GPUMarketLiquidity.sol";
import {GPUToken} from "../../src/GPUToken.sol";
import {GPUHook} from "../../src/hooks/GPUHook.sol";
import {MockGPUPriceOracle} from "../../src/oracle/MockGPUPriceOracle.sol";
import {IGPUPriceOracle} from "../../src/oracle/IGPUPriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {HookMiner} from "v4-periphery-test/shared/HookMiner.sol";

/// @notice Fee-matrix + degradation rig for the C-max GPUHook. The same suite
///         runs under both currency orderings: `_wantGusdIsCurrency0`
///         brute-forces a GPU id whose CREATE2 token address lands on the
///         requested side of gUSD, so every test executes with gUSD = currency0
///         and again with gUSD = currency1.
/// @dev    The pool initializes at the oracle-derived tick for $2.50/GPU with a
///         ±120-tick LP band: native spot sits at the hook's edges' centre, so
///         small swaps are 100% native and ~0.4 gUSD of native depth separates
///         spot from each edge (band depth ≈ 19 gUSD / 7.6 GPU per side).
///         hookFeeBps defaults to 0 (retired mechanism); fee-shape tests opt in
///         with setHookFeeBps(50).
abstract contract GPUHookTestBase is Test, Deployers {
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
    bool internal gIsC0;
    int24 internal initTick;
    uint256 internal price; // oracle convention: 4 decimals (25_000 = 2.5)

    uint16 internal constant HOOK_FEE_BPS = 50; // opt-in for fee-shape tests
    uint16 internal constant POL_FEE_BPS = 10;
    uint16 internal constant SPREAD_BPS = 50;
    uint24 internal constant POOL_FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    // event topics (avoids cross-contract event-selector syntax)
    bytes32 private constant _HOOK_SWAP_TOPIC =
        keccak256("HookSwap(bytes32,address,int128,int128,uint24)");
    bytes32 private constant _GPU_FILL_TOPIC =
        keccak256("GpuFill(bytes32,bytes32,address,bool,uint256,uint256,uint256,uint8)");

    struct Fill {
        bool isBuy;
        uint256 gpuAmt;
        uint256 gusdAmt;
        uint256 fee;
        uint8 src;
    }

    function _wantGusdIsCurrency0() internal view virtual returns (bool);

    function setUp() public virtual {
        vm.warp(1_000_000);
        deployFreshManagerAndRouters();
        underlying = new MockERC20("USD Coin", "USDC", 6);
        gusd = new GUSD(IERC20(address(underlying)), address(this));
        ledger = address(new RevenueLedger(IERC20(address(gusd)), address(this)));
        oracle = new MockGPUPriceOracle(address(this));
        pol = new GPUMarketLiquidity(IERC20(address(gusd)), address(manager), address(this));
        issuance = new GPUIssuance(
            IERC20(address(gusd)), IGPUPriceOracle(address(oracle)), ledger, address(pol), address(this)
        );
        GPU_ID = _pickGpuId(_wantGusdIsCurrency0());

        // mine a salt so the low 14 bits equal the v2 flag set (0x10CC)
        bytes memory ctorArgs =
            abi.encode(IPoolManager(address(manager)), address(gusd), IGPUPriceOracle(address(oracle)), issuance, ledger, address(this));
        uint160 flags = uint160(
            Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        (address hookAddr, bytes32 salt) = HookMiner.find(address(this), flags, type(GPUHook).creationCode, ctorArgs);
        hook = GPUHook(hookAddr);
        new GPUHook{salt: salt}(
            IPoolManager(address(manager)), address(gusd), IGPUPriceOracle(address(oracle)), issuance, ledger, address(this)
        );
        pol.setRefs(address(issuance), address(hook));

        gusd.setRevenueSink(ledger);
        RevenueLedger(ledger).setVault(makeAddr("sgusdVault"));
        RevenueLedger(ledger).setTreasury(makeAddr("treasury"));
        issuance.createGpu(GPU_ID, "GPU hour", "GPU", 50, POOL_FEE, TICK_SPACING);
        issuance.setIssuanceEnabled(GPU_ID, true);
        gpu = GPUToken(issuance.tokenOf(GPU_ID));
        price = 25_000; // 2.5000 gUSD/GPU
        oracle.setPrice(GPU_ID, price, block.timestamp);
        gIsC0 = address(gusd) < address(gpu);
        // raw price = 2.5e-12 gUSD-wei per GPU-wei -> raw tick ~267_161; init aligned to spacing
        initTick = gIsC0 ? int24(267_120) : int24(-267_120); // spacing-aligned (raw ref ~267_161)
        manager.initialize(_canonicalKey(), TickMath.getSqrtPriceAtTick(initTick));
        stateView = new StateView(manager);

        // Approve the swap router once: _swap must not emit Approval events,
        // which would consume vm.expectEmit/vm.expectRevert expectations.
        IERC20(address(gusd)).approve(address(swapRouter), type(uint256).max);
        IERC20(address(gpu)).approve(address(swapRouter), type(uint256).max);

        // LP the pool: ±120 band around the oracle tick (~19 gUSD / 7.6 GPU
        // of total depth per side; ~0.4 gUSD from spot to each hook edge)
        _dealBoth(address(this), 1_000_000e6, 0);
        _issueGpu(address(this), 1_000_000e18);
        IERC20(address(gusd)).approve(address(modifyLiquidityRouter), type(uint256).max);
        IERC20(address(gpu)).approve(address(modifyLiquidityRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity(
            _canonicalKey(),
            ModifyLiquidityParams({tickLower: initTick - 120, tickUpper: initTick + 120, liquidityDelta: 1e15, salt: 0}),
            ""
        );
    }

    // ------------------------------------------------------------- helpers

    /// @dev Brute-forces a GPU id whose CREATE2 token address satisfies the
    ///      requested ordering relative to gUSD (expected ~2 iterations).
    function _pickGpuId(bool wantTokenAboveGusd) internal view returns (bytes32) {
        for (uint256 i; i < 1024; ++i) {
            bytes32 id = bytes32(bytes(string.concat("GPU_V2_TEST_", vm.toString(i))));
            address predicted = vm.computeCreate2Address(
                id,
                keccak256(
                    abi.encodePacked(type(GPUToken).creationCode, abi.encode(address(issuance), id, "GPU hour", "GPU"))
                ),
                address(issuance)
            );
            if (wantTokenAboveGusd ? predicted > address(gusd) : predicted < address(gusd)) return id;
        }
        revert("no gpu id on requested side");
    }

    function _canonicalKey() internal view returns (PoolKey memory) {
        (Currency c0, Currency c1) = gIsC0
            ? (Currency.wrap(address(gusd)), Currency.wrap(address(gpu)))
            : (Currency.wrap(address(gpu)), Currency.wrap(address(gusd)));
        return PoolKey({currency0: c0, currency1: c1, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: hook});
    }

    /// @dev BUY = gUSD -> GPU: zeroForOne iff gUSD is currency0.
    function _buyZeroForOne() internal view returns (bool) {
        return gIsC0;
    }

    function _dealBoth(address to, uint256 gusdAmt, uint256 gpuAmt) internal {
        deal(address(underlying), to, gusdAmt);
        vm.startPrank(to);
        underlying.approve(address(gusd), type(uint256).max);
        gusd.mint(gusdAmt, to);
        vm.stopPrank();
        if (gpuAmt > 0) _issueGpu(to, gpuAmt);
    }

    /// @dev Mints GPU tokens to `to` by paying issuance from gUSD.
    function _issueGpu(address to, uint256 amount) internal {
        deal(address(gusd), to, amount + 100e6);
        vm.startPrank(to);
        gusd.approve(address(issuance), type(uint256).max);
        issuance.issue(GPU_ID, amount, to);
        vm.stopPrank();
    }

    function _hookFeeFor(uint256 basis) internal pure returns (uint256) {
        return Math.mulDiv(basis, HOOK_FEE_BPS, 10_000, Math.Rounding.Ceil);
    }

    function _issueFeeFor(uint256 base) internal view returns (uint256) {
        return Math.mulDiv(base, 50, 10_000, Math.Rounding.Ceil);
    }

    /// @dev gUSD-wei price denominators at the current oracle price. A GPU
    ///      amount times the denominator over 1e20 (ceil for asks) gives the
    ///      gUSD-wei cost, matching the hook's own rounding.
    function _askDenom() internal view returns (uint256) {
        return price * (10_000 + SPREAD_BPS);
    }

    function _bidDenom() internal view returns (uint256) {
        return price * (10_000 - SPREAD_BPS);
    }

    /// @dev Swaps from the test contract; returns the swapper's gUSD balance delta.
    function _swap(bool zeroForOne, int256 amountSpecified) internal returns (int256 gusdDelta) {
        uint256 gBefore = gusd.balanceOf(address(this));
        swapRouter.swap(
            _canonicalKey(),
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        gusdDelta = int256(gusd.balanceOf(address(this))) - int256(gBefore);
    }

    /// @dev Like _swap but without the balance read: a vm.expectRevert placed
    ///      before it observes the swap call itself, not a staticcall.
    function _swapRaw(bool zeroForOne, int256 amountSpecified) internal {
        swapRouter.swap(
            _canonicalKey(),
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev The native leg's core Swap event gUSD delta from the recorded-log
    ///      buffer (hook fills emit GpuFill, never Swap; the buffer is
    ///      CONSUMED — read this before _records()). Decomposition input for
    ///      fee asserts on mixed native+hook shapes.
    function _nativeGusdOut() internal view returns (int256 gusdOut) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        PoolId id = _canonicalKey().toId();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(manager) || logs[i].topics.length != 3) continue;
            if (logs[i].topics[1] != PoolId.unwrap(id)) continue;
            (int128 amount0, int128 amount1,,,,) = abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
            gusdOut = gIsC0 ? amount0 : amount1;
        }
    }

    /// @dev Removes the ±120 band (position is the test contract's own), for
    ///      no-capacity and cold-start tests.
    function _clearLp() internal {
        modifyLiquidityRouter.modifyLiquidity(
            _canonicalKey(),
            ModifyLiquidityParams({tickLower: initTick - 120, tickUpper: initTick + 120, liquidityDelta: -1e15, salt: 0}),
            ""
        );
    }

    /// @dev Single-read recorder: GpuFill fills + HookSwap count since the
    ///      last vm.recordLogs. vm.getRecordedLogs() CONSUMES the buffer in
    ///      this build — tests must derive every result from one call.
    function _records() internal view returns (Fill[] memory out, uint256 hookSwaps) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        PoolId id = _canonicalKey().toId();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(hook)) continue;
            if (logs[i].topics.length == 4 && logs[i].topics[0] == _GPU_FILL_TOPIC) {
                ++n;
            } else if (
                logs[i].topics.length == 3 && logs[i].topics[0] == _HOOK_SWAP_TOPIC
                    && logs[i].topics[1] == PoolId.unwrap(id)
            ) {
                ++hookSwaps;
            }
        }
        out = new Fill[](n);
        uint256 k;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hook) && logs[i].topics.length == 4 && logs[i].topics[0] == _GPU_FILL_TOPIC) {
                (bool isBuy, uint256 gpuAmt, uint256 gusdAmt, uint256 fee, uint8 src) =
                    abi.decode(logs[i].data, (bool, uint256, uint256, uint256, uint8));
                out[k] = Fill({isBuy: isBuy, gpuAmt: gpuAmt, gusdAmt: gusdAmt, fee: fee, src: src});
                ++k;
            }
        }
    }

    // ------------------------------------------------------- registration

    function test_hookAddressFlagsV2() public view {
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, 0x10CC);
        // rig default: hook fee off (tests opt in via HOOK_FEE_BPS); staleness gate is 25h
        assertEq(hook.hookFeeBps(), 0);
        assertEq(hook.maxOracleStaleness(), 25 hours);
        assertEq(hook.maxWalkTicks(), 48);
    }


    // ------------------------------------------------------- registration

    function test_canonicalPoolRegisters() public view {
        assertEq(hook.poolGpuId(_canonicalKey().toId()), GPU_ID);
    }

    function test_wrongFeeTierReverts() public {
        PoolKey memory key = _canonicalKey();
        key.fee = 500;
        vm.expectRevert(); // WrappedError(NotCanonicalPool) bubbles through core
        manager.initialize(key, SQRT_PRICE_1_1);
    }

    function test_wrongTickSpacingReverts() public {
        PoolKey memory key = _canonicalKey();
        key.tickSpacing = 10;
        vm.expectRevert();
        manager.initialize(key, SQRT_PRICE_1_1);
    }

    function test_unknownGpuTokenReverts() public {
        MockERC20 fake = new MockERC20("FAKE", "FK", 18);
        (Currency c0, Currency c1) = address(fake) < address(gusd)
            ? (Currency.wrap(address(fake)), Currency.wrap(address(gusd)))
            : (Currency.wrap(address(gusd)), Currency.wrap(address(fake)));
        PoolKey memory key =
            PoolKey({currency0: c0, currency1: c1, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: hook});
        vm.expectRevert();
        manager.initialize(key, SQRT_PRICE_1_1);
    }

    function test_gusdBothSidesReverts() public {
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(gusd)),
            currency1: Currency.wrap(address(gusd)),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: hook
        });
        vm.expectRevert();
        manager.initialize(key, SQRT_PRICE_1_1);
    }

    // ---------------------------------------------------- polState + params

    function test_polParamsDefaults() public view {
        (uint16 askBps, uint16 bidBps, uint16 polFeeBps, bool live, uint256 askPrice, uint256 bidPrice) =
            hook.polState(GPU_ID);
        assertEq(askBps, SPREAD_BPS);
        assertEq(bidBps, SPREAD_BPS);
        assertEq(polFeeBps, POL_FEE_BPS);
        assertTrue(live, "hook live at fresh oracle");
        assertEq(askPrice, 25_125); // 2.5 * 1.005
        assertEq(bidPrice, 24_875); // 2.5 * 0.995
    }

    function test_setPolParamsBoundsAndSolvency() public {
        hook.setPolParams(GPU_ID, 100, 100, 100);
        (uint16 askBps, uint16 bidBps, uint16 polFeeBps, bool live, uint256 askPrice, uint256 bidPrice) =
            hook.polState(GPU_ID);
        assertEq(askBps, 100);
        assertEq(bidBps, 100);
        assertEq(polFeeBps, 100);
        assertEq(askPrice, 25_125); // 100 bps capped at the issuance ask (issueFeeBps=50)
        assertEq(bidPrice, 24_750); // bid carries no cap
        // R2 solvency: polFeeBps must not exceed askBps
        vm.expectRevert(GPUHook.FeeTooLarge.selector);
        hook.setPolParams(GPU_ID, 50, 50, 60);
        vm.expectRevert(GPUHook.FeeTooLarge.selector);
        hook.setPolParams(GPU_ID, 5_001, 50, 10);
        // restore shipped defaults
        hook.setPolParams(GPU_ID, SPREAD_BPS, SPREAD_BPS, POL_FEE_BPS);
        (askBps, bidBps, polFeeBps,, askPrice, bidPrice) = hook.polState(GPU_ID);
        assertEq(askPrice, 25_125);
    }

    // --------------------------------------------------------- fee matrix
    // Four shapes x {0% (native-only), partial, 100% hook fill}, with
    // hookFeeBps=50 opted in. Identities (verified against GPUHook.sol):
    //   buy exactOut:  hookFee = ceil((polSpend + issueBase + issueFee) * f)
    //                  counter totalHookFeesGusd += hookFee
    //   buy exactIn:   hookFee = ceil(absorb * f) OUT OF THE ABSORBED BUDGET
    //                  (ladder runs on budget = absorb - hookFee, swapper
    //                  gets the full gross fills); counter bumped
    //   sells:         hookFee = ceil((gross - polFee) * f) on POL legs only
    //                  (native legs are hook-fee-free); counter incremented

    function test_buyNativeOnly_noHookFeeNoFill() public {
        hook.setHookFeeBps(HOOK_FEE_BPS);
        uint256 fees0 = hook.totalHookFeesGusd();
        uint256 polNotional0 = hook.totalPolNotionalGusd();
        PoolId id = _canonicalKey().toId();
        (uint256 g0, uint256 g1) = stateView.getFeeGrowthGlobals(id);
        vm.recordLogs();
        int256 d = _swap(_buyZeroForOne(), -1e5); // 0.1 gUSD: inside the spread
        assertGt(gpu.balanceOf(address(this)), 0);
        assertEq(d, -int256(1e5)); // exactIn pays the full budget
        assertEq(hook.totalHookFeesGusd() - fees0, 0, "native legs carry no hook fee");
        assertEq(hook.totalPolNotionalGusd() - polNotional0, 0, "in-swap fills book their notional");
        (Fill[] memory fills, uint256 hookSwaps) = _records();
        assertEq(fills.length, 0, "no GpuFill on native-only");
        assertEq(hookSwaps, 0, "URC-2: none on zero-fill");
        (uint256 g0After, uint256 g1After) = stateView.getFeeGrowthGlobals(id);
        if (_buyZeroForOne()) assertGt(g0After, g0, "LP fee accrued on the gUSD input side");
        else assertGt(g1After, g1, "LP fee accrued on the gUSD input side");
    }



    /// Partial: buy exactOut 1 GPU -> ~0.16 GPU native + backstop tail.
    function test_buyExactOut_feeOnCharge() public {
        hook.setHookFeeBps(HOOK_FEE_BPS);
        uint256 fees0 = hook.totalHookFeesGusd();
        uint256 polFees0 = hook.totalPolFeesGusd();
        uint256 principal0 = pol.principalContributed(GPU_ID);
        uint256 ledgerG0 = gusd.balanceOf(ledger);
        PoolId id = _canonicalKey().toId();
        vm.recordLogs();
        int256 d = _swap(_buyZeroForOne(), int256(1e18)); // demand 1 GPU
        // native ~0.16 GPU at 2.5, backstop tail at ask*1.005: 2.47..2.60 gUSD
        assertGe(d, -int256(2_600_000));
        assertLe(d, -int256(2_470_000));
        uint256 issueBase = pol.principalContributed(GPU_ID) - principal0;
        uint256 issueFee = _issueFeeFor(issueBase);
        uint256 expectedFee = _hookFeeFor(issueBase + issueFee); // polSpend = 0 (empty vault)
        assertEq(hook.totalHookFeesGusd() - fees0, expectedFee, "hookFee = ceil(charge*50bps)");
        assertEq(hook.totalPolFeesGusd() - polFees0, 0, "backstop books no POL fee");
        assertEq(
            gusd.balanceOf(ledger) - ledgerG0, issueFee + expectedFee, "ledger got issueFee + hookFee"
        );
        (Fill[] memory fills, uint256 hookSwaps) = _records();
        assertEq(hookSwaps, 1, "URC-2: one HookSwap");
        assertGe(fills.length, 1, "backstop fill recorded");
        assertEq(fills[0].src, 1, "issuance backstop source");
    }

    /// Buy exactIn: the hook fee is charged in gUSD OUT OF THE ABSORBED BUDGET —
    /// the ladder runs on budget = absorb − hookFeeGusd, the swapper receives
    /// the full gross fills, and the fee lands on the ledger with the counter
    /// bumped (the specified leg is frozen at beforeSwap, so charging the
    /// buyer extra gUSD is impossible; deducting from the absorb budget is
    /// the economically identical shape).
    function test_buyExactIn_feeFromBudget() public {
        hook.setHookFeeBps(HOOK_FEE_BPS);
        uint256 fees0 = hook.totalHookFeesGusd();
        uint256 ledgerG0 = gusd.balanceOf(ledger);
        uint256 ledgerGpu0 = gpu.balanceOf(ledger);
        uint256 hookG0 = gusd.balanceOf(address(hook));
        uint256 gpuBefore = gpu.balanceOf(address(this));
        uint256 principal0 = pol.principalContributed(GPU_ID);
        PoolId id = _canonicalKey().toId();
        vm.recordLogs();
        int256 d = _swap(_buyZeroForOne(), -5e6); // 5 gUSD budget
        assertEq(d, -int256(5e6), "pays the full budget");
        // Single read (the log buffer is consumed): the hook's HookSwap gives
        // absorb (its gUSD debit) + the gross GPU delivered; the core Swap
        // event gives the native leg, so both fee basis and delivery
        // decompose without a second getRecordedLogs.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        int128 hookGusd = 0;
        int128 hookGpu = 0;
        int128 nativeGusd = 0;
        int128 nativeGpu = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 3 && logs[i].topics[1] == PoolId.unwrap(id)) {
                if (logs[i].emitter == address(hook) && logs[i].topics[0] == _HOOK_SWAP_TOPIC) {
                    (int128 a0, int128 a1,) = abi.decode(logs[i].data, (int128, int128, uint24));
                    (hookGusd, hookGpu) = gIsC0 ? (a0, a1) : (a1, a0);
                } else if (logs[i].emitter == address(manager)) {
                    (int128 a0, int128 a1,,,,) =
                        abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
                    (nativeGusd, nativeGpu) = gIsC0 ? (a0, a1) : (a1, a0);
                }
            }
        }
        uint256 absorb = uint256(int256(-hookGusd));
        uint256 grossGpu = uint256(int256(hookGpu));
        assertGt(absorb, 0, "buy crosses the edge");
        assertGt(grossGpu, 0, "backstop fill delivered");
        assertEq(absorb, 5e6 - uint256(int256(-nativeGusd)), "absorb = budget - native leg");
        uint256 expectedFee = _hookFeeFor(absorb);
        uint256 issueFee = _issueFeeFor(pol.principalContributed(GPU_ID) - principal0);
        assertGt(issueFee, 0, "backstop minted");
        assertEq(hook.totalHookFeesGusd() - fees0, expectedFee, "counter bumped by the budget fee");
        assertEq(
            gusd.balanceOf(ledger) - ledgerG0, expectedFee + issueFee, "ledger got hookFee + issueFee (polFee = 0: empty vault)"
        );
        assertEq(gpu.balanceOf(ledger) - ledgerGpu0, 0, "no in-kind GPU fee");
        assertEq(gusd.balanceOf(address(hook)) - hookG0, 0, "nothing retained");
        assertEq(gpu.balanceOf(address(this)) - gpuBefore, grossGpu + uint256(int256(nativeGpu)), "full gross fills to the swapper");
    }

    /// 100% POL: seed ask inventory (buy -> bid, sell -> vault GPU), then
    /// reprice the oracle BELOW native spot — spot is beyond the ask edge, so
    /// the whole demand fills from vault inventory at the fresh ask.
    function test_buyExactOut_allPol() public {
        hook.setHookFeeBps(HOOK_FEE_BPS);
        _swap(_buyZeroForOne(), -5e6); // seed bid inventory via the backstop
        _swap(!_buyZeroForOne(), -4e18); // seller -> vault acquires ~0.8 GPU
        uint256 askInv0 = pol.askInventoryGpu(GPU_ID);
        assertTrue(askInv0 > 2e17, "vault holds GPU");
        price = 24_000; // $2.40: ask edge (2.4120) below native spot
        oracle.setPrice(GPU_ID, price, block.timestamp);
        uint256 fees0 = hook.totalHookFeesGusd();
        uint256 polNot0 = hook.totalPolNotionalGusd();
        vm.recordLogs();
        _swap(_buyZeroForOne(), int256(2e17)); // demand 0.2 GPU
        (Fill[] memory fills,) = _records();
        assertEq(fills.length, 1, "single POL fill");
        assertTrue(fills[0].isBuy && fills[0].src == 0);
        assertEq(fills[0].gpuAmt, 2e17, "whole demand from POL");
        uint256 expectedSpend = Math.mulDiv(2e17, price * (10_000 + SPREAD_BPS), 1e20, Math.Rounding.Ceil);
        assertEq(fills[0].gusdAmt, expectedSpend, "charged at the fresh ask");
        assertEq(hook.totalPolNotionalGusd() - polNot0, expectedSpend, "POL notional booked");
        assertEq(hook.totalHookFeesGusd() - fees0, _hookFeeFor(expectedSpend), "hook fee on the charge");
        assertEq(pol.askInventoryGpu(GPU_ID), askInv0 - 2e17, "inventory drained");
    }

    /// 0%: small sells stay inside the spread — all native, all fee-free.
    function test_sellNativeOnly_feeFree() public {
        hook.setHookFeeBps(HOOK_FEE_BPS);
        uint256 fees0 = hook.totalHookFeesGusd();
        uint256 polNot0 = hook.totalPolNotionalGusd();
        PoolId id = _canonicalKey().toId();
        (uint256 g0, uint256 g1) = stateView.getFeeGrowthGlobals(id);
        vm.recordLogs();
        int256 d = _swap(!_buyZeroForOne(), -5e16); // 0.05 GPU: inside the spread
        assertGt(d, 0);
        assertEq(hook.totalHookFeesGusd() - fees0, 0, "native legs carry no hook fee");
        assertEq(hook.totalPolNotionalGusd() - polNot0, 0, "no POL participation");
        (Fill[] memory fills, uint256 hookSwaps) = _records();
        assertEq(fills.length, 0, "no GpuFill on native-only");
        assertEq(hookSwaps, 0, "URC-2: none on zero-fill");
        (uint256 g0After, uint256 g1After) = stateView.getFeeGrowthGlobals(id);
        if (_buyZeroForOne()) assertGt(g1After, g1, "LP fee accrued on the GPU input side");
        else assertGt(g0After, g0, "LP fee accrued on the GPU input side");
    }

    /// Partial sell: native leg + vault bid. hookFee = ceil((gross - polFee)*f).
    function test_sellExactIn_feeOnNetPolSpend() public {
        hook.setHookFeeBps(HOOK_FEE_BPS);
        _swap(_buyZeroForOne(), -5e6); // seed bid inventory via the backstop
        uint256 fees0 = hook.totalHookFeesGusd();
        uint256 polNot0 = hook.totalPolNotionalGusd();
        uint256 polFees0 = hook.totalPolFeesGusd();
        uint256 ledgerG0 = gusd.balanceOf(ledger);
        PoolId id = _canonicalKey().toId();
        vm.recordLogs();
        int256 d = _swap(!_buyZeroForOne(), -4e18); // sell 4 GPU: crosses the bid edge
        assertGt(d, 0);
        uint256 gross = hook.totalPolNotionalGusd() - polNot0;
        uint256 polFee = hook.totalPolFeesGusd() - polFees0;
        assertGt(gross, 0);
        assertEq(hook.totalHookFeesGusd() - fees0, _hookFeeFor(gross - polFee), "fee on net POL spend");
        assertEq(gusd.balanceOf(ledger) - ledgerG0, polFee + _hookFeeFor(gross - polFee), "ledger got polFee + hookFee");
        (, uint256 hookSwaps) = _records();
        assertEq(hookSwaps, 1);
    }

    /// Sell exactOut: seller demands NET gUSD; seller bears both fees through
    /// the absorb price. hookFee basis is the hook's committed supply C.
    function test_sellExactOut_feeOnNet() public {
        hook.setHookFeeBps(HOOK_FEE_BPS);
        _swap(_buyZeroForOne(), -10e6); // seed bid inventory (~9.5 gUSD)
        uint256 fees0 = hook.totalHookFeesGusd();
        uint256 polNot0 = hook.totalPolNotionalGusd();
        uint256 polFees0 = hook.totalPolFeesGusd();
        uint256 ledgerG0 = gusd.balanceOf(ledger);
        uint256 askInv0 = pol.askInventoryGpu(GPU_ID);
        vm.recordLogs();
        int256 d = _swap(!_buyZeroForOne(), int256(1e7)); // demand 10 gUSD net
        assertEq(d, int256(1e7), "seller receives exactly the demand");
        int256 nativeGusd = _nativeGusdOut();
        // C-primary: the hook funds the walk shortfall C; the seller bears
        // both fees through the absorb price (gross = C + fees at bid).
        uint256 supply = uint256(1e7 - nativeGusd);
        uint256 gross = hook.totalPolNotionalGusd() - polNot0;
        uint256 polFee = hook.totalPolFeesGusd() - polFees0;
        assertEq(
            gross,
            supply + Math.mulDiv(supply, POL_FEE_BPS, 1e4, Math.Rounding.Ceil) + _hookFeeFor(supply),
            "gross = supply + fees"
        );
        assertEq(polFee, Math.mulDiv(supply, POL_FEE_BPS, 1e4, Math.Rounding.Ceil), "POL fee on the hook supply");
        assertEq(hook.totalHookFeesGusd() - fees0, _hookFeeFor(supply), "hook fee on the hook supply");
        assertEq(
            gusd.balanceOf(ledger) - ledgerG0, polFee + _hookFeeFor(supply), "ledger got polFee + hookFee"
        );
        uint256 bidDenom = price * (10_000 - SPREAD_BPS);
        assertEq(
            pol.askInventoryGpu(GPU_ID) - askInv0,
            Math.mulDiv(gross, 1e20, bidDenom, Math.Rounding.Ceil),
            "vault acquired ceil-recovered GPU"
        );
    }

    /// hookFeeBps = 0 (shipped default): fills still happen, fees all zero.
    function test_zeroHookFee_noFees() public {
        uint256 fees0 = hook.totalHookFeesGusd();
        uint256 ledgerGpu0 = gpu.balanceOf(ledger);
        uint256 ledgerG0 = gusd.balanceOf(ledger);
        uint256 principal0 = pol.principalContributed(GPU_ID);
        vm.recordLogs();
        _swap(_buyZeroForOne(), -5e6); // crosses the edge, backstop fills
        (Fill[] memory fills,) = _records();
        assertGe(fills.length, 1, "backstop still fills");
        assertEq(hook.totalHookFeesGusd() - fees0, 0, "no hook fee");
        assertEq(gpu.balanceOf(ledger) - ledgerGpu0, 0, "no GPU fee to ledger");
        uint256 issueBase = pol.principalContributed(GPU_ID) - principal0;
        assertGt(issueBase, 0);
        assertEq(
            gusd.balanceOf(ledger) - ledgerG0, _issueFeeFor(issueBase), "ledger got only the issuance fee"
        );
    }

    // ---------------------------------------------------------- degradation

    /// Stale oracle: the hook is inert — no POL, no backstop, no fees, no
    /// fills. Small swaps run purely native; oversized demand partial-fills
    /// (never reverts, never fabricates).
    function test_staleOracle_hookInert() public {
        vm.warp(block.timestamp + 26 hours);
        (, , , bool live, , ) = hook.polState(GPU_ID);
        assertFalse(live, "stale oracle => not live");
        uint256 fees0 = hook.totalHookFeesGusd();
        uint256 polNot0 = hook.totalPolNotionalGusd();
        uint256 principal0 = pol.principalContributed(GPU_ID);
        uint256 issued0 = issuance.gpuConfig(GPU_ID).totalIssued;
        vm.recordLogs();
        int256 d = _swap(_buyZeroForOne(), -1e5); // small: purely native
        assertGt(gpu.balanceOf(address(this)), 0);
        (Fill[] memory fills,) = _records();
        assertEq(fills.length, 0, "no fills");        assertEq(hook.totalHookFeesGusd() - fees0, 0);
        assertEq(hook.totalPolNotionalGusd() - polNot0, 0);
        assertEq(pol.principalContributed(GPU_ID) - principal0, 0);
        assertEq(issuance.gpuConfig(GPU_ID).totalIssued - issued0, 0, "no in-swap mint");
        // oversized demand: walk exhausts the band, partial fill, no revert
        uint256 gpuBefore = gpu.balanceOf(address(this));
        _swap(_buyZeroForOne(), -30e6); // 30 gUSD > ~19 gUSD of native depth
        uint256 got = gpu.balanceOf(address(this)) - gpuBefore;
        assertGt(got, 0);
        assertLt(got, Math.mulDiv(30e6, 1e20, price * 10_000, Math.Rounding.Ceil), "partial, not fabricated");
        assertEq(hook.totalHookFeesGusd() - fees0, 0, "still fee-free");
        assertEq(pol.principalContributed(GPU_ID) - principal0, 0, "still no backstop");
    }

    /// polPaused: the ask edge collapses to the oracle price (0 spread) —
    /// emergency fair-value mode. polState.live flips false; bid + backstop
    /// pricing are untouched.
    function test_polPaused_askAtOraclePrice() public {
        _swap(_buyZeroForOne(), -5e6); // seed bid inventory
        _swap(!_buyZeroForOne(), -4e18); // vault acquires GPU
        uint256 askInv0 = pol.askInventoryGpu(GPU_ID);
        assertTrue(askInv0 > 1e17);
        hook.setPolPaused(true);
        (uint16 askBps, uint16 bidBps, uint16 polFeeBps, bool live, uint256 askPrice, uint256 bidPrice) =
            hook.polState(GPU_ID);
        assertFalse(live, "paused => not live");
        assertEq(askBps, SPREAD_BPS); // stored params unchanged...
        assertEq(bidBps, SPREAD_BPS);
        assertEq(polFeeBps, POL_FEE_BPS);
        assertEq(askPrice, price, "ask edge = oracle price (0 spread)");
        assertEq(bidPrice, Math.mulDiv(price, 1e4 - SPREAD_BPS, 1e4), "bid edge unchanged");
        uint256 polNot0 = hook.totalPolNotionalGusd();
        vm.recordLogs();
        _swap(_buyZeroForOne(), int256(2e18)); // demand 2 GPU: crosses the 0-spread edge
        (Fill[] memory fills,) = _records();
        assertGe(fills.length, 1, "fills continue while paused");
        uint256 polGpu = 0;
        for (uint256 i; i < fills.length; ++i) {
            if (fills[i].src == 0) polGpu += fills[i].gpuAmt;
        }
        assertGt(polGpu, 0, "POL participates");
        uint256 expectedSpend = Math.mulDiv(polGpu, price * 10_000, 1e20, Math.Rounding.Ceil);
        assertEq(hook.totalPolNotionalGusd() - polNot0, expectedSpend, "charged at ORACLE price, no spread");
    }

    /// @dev v4-core wraps hook-callback reverts in ERC-7751 WrappedError
    ///      (CustomRevert.bubbleUpAndRevertWith) — the bare inner error never
    ///      reaches the caller, so expectRevert must match the wrap itself.
    function _expectHookRevert(bytes4 innerSelector) internal {
        // The inner error data is 4 bytes for a no-arg custom error: the
        // wrap's `reason` bytes field carries exactly those 4 bytes.
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeSwap.selector,
                abi.encodePacked(innerSelector),
                abi.encodePacked(Hooks.HookCallFailed.selector)
            )
        );
    }

    /// No capacity: no LPs (band removed), no POL (empty vault), no backstop
    /// (issuance disabled) => InsufficientMarketCapacity, honestly, for both
    /// directions. Re-enabling issuance restores the cold start.
    function test_insufficientCapacity_reverts() public {
        _clearLp();
        issuance.setIssuanceEnabled(GPU_ID, false);
        (, , , bool live, , ) = hook.polState(GPU_ID);
        assertTrue(live, "oracle fresh; capacity, not liveness, is the limit");
        _expectHookRevert(GPUHook.InsufficientMarketCapacity.selector);
        _swapRaw(_buyZeroForOne(), -2e6);
        _expectHookRevert(GPUHook.InsufficientMarketCapacity.selector);
        _swapRaw(!_buyZeroForOne(), -1e15);
        // cold start: with issuance back on, the empty market serves the buy
        issuance.setIssuanceEnabled(GPU_ID, true);
        // R3: a direct late-settling swapper fills only from the PM's
        // physical float — zero on a cleared book — so pre-settle the buyer's
        // input into the PM (pay-then-swap is the supported direct path).
        gusd.transfer(address(manager), 2e6);
        uint256 issued0 = issuance.gpuConfig(GPU_ID).totalIssued;
        uint256 principal0 = pol.principalContributed(GPU_ID);
        vm.recordLogs();
        int256 d = _swap(_buyZeroForOne(), -2e6);
        assertEq(d, -int256(2e6));
        assertGt(issuance.gpuConfig(GPU_ID).totalIssued - issued0, 0, "cold-start mint");
        assertGt(pol.principalContributed(GPU_ID) - principal0, 0, "principal capitalized");
        (Fill[] memory fills,) = _records();
        assertEq(fills.length, 1);
        assertEq(fills[0].src, 1, "100% backstop on an empty market");
    }

    /// R3: PoolSwapTest settles AFTER the swap, so the hook's take is capped
    /// by the PM's physical balance (the LP float). Absorb never exceeds it,
    /// and the residual runs natively — a late-settling swapper degrades to a
    /// float-limited hook fill plus native continuation, never a revert.
    function test_r3_directSwapFillsWithinPmFloat() public {
        uint256 pmFloat = IERC20(address(gusd)).balanceOf(address(manager));
        assertTrue(pmFloat > 5e6, "LP float backs in-lock takes");
        uint256 fees0 = hook.totalHookFeesGusd();
        uint256 principal0 = pol.principalContributed(GPU_ID);
        vm.recordLogs();
        int256 d = _swap(_buyZeroForOne(), -30e6); // 30 gUSD > float
        assertGt(d, -int256(30e6), "dry native leg partial-fills: unexecuted input not charged");
        assertLt(d, -int256(pmFloat), "float + native leg both consumed");
        uint256 issueBase = pol.principalContributed(GPU_ID) - principal0;
        assertGt(issueBase, 0, "backstop filled beyond the native book");
        // absorb ≈ issueBase * (1e4 + 50) / 1e4 (backstop total) must have fit
        // inside the PM float (plus the caller's late settle)
        assertLe(Math.mulDiv(issueBase, 10_050, 10_000), pmFloat + 2e6, "absorb within float");
        (Fill[] memory fills,) = _records();
        assertGe(fills.length, 1);
        assertEq(fills[0].src, 1);
        assertLe(fills[0].gusdAmt, pmFloat, "R3: backstop total within the PM float");
    }

    /// The router's exact boundary: a pay-then-swap buyer pre-settles the
    /// quoted all-in total (charge + hookFee) — pmPhys then equals the
    /// all-in plus whatever wei the pool's band stranded (production GPU
    /// pools carry no band, so there pmPhys is the all-in to the wei). The
    /// fee-adjusted spend cap must admit the full charge — a blind
    /// ceiling-minus-one reserve strands a dust residual and reverts an
    /// honest exact-total buy. The ledger closes with only the strand left.
    function test_buyExactOut_preSettledAllInFills() public {
        hook.setHookFeeBps(HOOK_FEE_BPS);
        _clearLp(); // the band's float would pad pmPhys past the all-in
        uint256 dust0 = gusd.balanceOf(address(manager));
        assertTrue(dust0 <= 1, "cleared book strands at most one wei");
        (uint256 base, uint256 fee, uint256 total) = issuance.quoteIssue(GPU_ID, 2e17);
        assertTrue(total > 0 && total == base + fee, "issuance quote live");
        uint256 allIn = total + _hookFeeFor(total); // the GpuQuoter's gusdIn
        PayThenSwapBuyer buyer = new PayThenSwapBuyer(IPoolManager(address(manager)));
        gusd.transfer(address(buyer), allIn);
        uint256 fees0 = hook.totalHookFeesGusd();
        uint256 principal0 = pol.principalContributed(GPU_ID);
        uint256 ledgerG0 = gusd.balanceOf(ledger);
        vm.recordLogs();
        buyer.buy(_canonicalKey(), _buyZeroForOne(), int256(2e17), allIn, gIsC0);
        assertEq(IERC20(address(gpu)).balanceOf(address(buyer)), 2e17, "full demand delivered");
        assertEq(gusd.balanceOf(address(buyer)), 0, "pre-settled to the wei, no residue");
        (Fill[] memory fills,) = _records();
        assertEq(fills.length, 1, "single backstop fill");
        assertTrue(fills[0].isBuy && fills[0].src == 1);
        assertEq(fills[0].gpuAmt, 2e17);
        assertEq(fills[0].gusdAmt, total, "charged the issuance quote");
        assertEq(hook.totalHookFeesGusd() - fees0, _hookFeeFor(total), "hook fee on the charge");
        assertEq(pol.principalContributed(GPU_ID) - principal0, base, "principal capitalized");
        assertEq(gusd.balanceOf(ledger) - ledgerG0, fee + _hookFeeFor(total), "ledger got issueFee + hookFee");
        assertEq(gusd.balanceOf(address(manager)), dust0, "all-in consumed, only the strand remains");
    }

    /// R6: two swaps into the same pool within one lock. The hook plans each
    /// swap statelessly from live state (no transient plan storage), so the
    /// second swap sees the first's price movement and both fill correctly;
    /// the unlock must close with NonzeroDeltaCount == 0.
    function test_r6_doubleSwapInOneLock() public {
        NestedSwapper ns = new NestedSwapper(IPoolManager(address(manager)), gusd, IERC20(address(gpu)), address(ledger));
        _dealBoth(address(ns), 100e6, 0);
        _issueGpu(address(ns), 6e18);
        uint256 fees0 = hook.totalHookFeesGusd();
        uint256 principal0 = pol.principalContributed(GPU_ID);
        vm.recordLogs();
        ns.run(_canonicalKey(), _buyZeroForOne(), -5e6, -5e18);
        (Fill[] memory fills,) = _records();
        assertGe(fills.length, 2, "buy fill + sell fill in one lock");
        assertTrue(fills[0].isBuy, "first fill is the buy");
        assertFalse(fills[1].isBuy, "second fill is the sell");
        assertGt(pol.principalContributed(GPU_ID) - principal0, 0, "backstop fired on swap 1");
        assertGt(pol.askInventoryGpu(GPU_ID), 0, "vault acquired GPU on swap 2");
        assertEq(hook.totalHookFeesGusd() - fees0, 0, "fee default 0");
    }

    // ------------------------------------------------------- URC conformance

    /// URC-2: one HookSwap per hook-contributing swap, swapper-view signed
    /// deltas, the pool's swap fee carried out. (Zero-fill swaps emit none —
    /// asserted in test_buyNativeOnly_noHookFeeNoFill.)
    function test_urc2_hookSwapSemantics() public {
        hook.setHookFeeBps(HOOK_FEE_BPS);
        PoolId id = _canonicalKey().toId();
        vm.recordLogs();
        _swap(_buyZeroForOne(), -5e6);
        Vm.Log[] memory logs = vm.getRecordedLogs(); // single read: count + decode
        uint256 hookSwaps;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(hook) || logs[i].topics.length != 3) continue;
            if (logs[i].topics[0] != _HOOK_SWAP_TOPIC) continue;
            ++hookSwaps;
            (int128 a0, int128 a1, uint24 swapFee) = abi.decode(logs[i].data, (int128, int128, uint24));
            assertEq(swapFee, POOL_FEE, "pool swap fee carried");
            if (gIsC0) {
                assertLt(a0, 0, "gUSD leg negative (paid)");
                assertGt(a1, 0, "GPU leg positive (received)");
            } else {
                assertLt(a1, 0, "gUSD leg negative (paid)");
                assertGt(a0, 0, "GPU leg positive (received)");
            }
        }
        assertEq(hookSwaps, 1, "one HookSwap on a hook-covered buy");
    }

    /// URC-3: IHookStats — orientation-mapped vault reserves, effective
    /// liquidity mirror, self address, ERC165 conformance.
    function test_urc3_iHookStats() public {
        _swap(_buyZeroForOne(), -5e6); // -> bid inventory
        _swap(!_buyZeroForOne(), -4e18); // crosses the bid edge -> ask inventory
        uint256 bidInv = pol.bidInventoryGusd(GPU_ID);
        uint256 askInv = pol.askInventoryGpu(GPU_ID);
        assertGt(bidInv, 0);
        assertGt(askInv, 0);
        PoolKey memory key = _canonicalKey();
        (uint256 a0, uint256 a1) = hook.getReserves(key);
        if (gIsC0) {
            assertEq(a0, bidInv, "c0 = gUSD bid inventory");
            assertEq(a1, askInv, "c1 = GPU ask inventory");
        } else {
            assertEq(a0, askInv, "c0 = GPU ask inventory");
            assertEq(a1, bidInv, "c1 = gUSD bid inventory");
        }
        (uint256 e0, uint256 e1) = hook.getEffectiveLiquidity(key);
        assertEq(e0, a0);
        assertEq(e1, a1);
        assertEq(hook.hook(), address(hook));
        assertTrue(hook.supportsInterface(type(IHookStats).interfaceId));
        assertTrue(hook.supportsInterface(type(IHooks).interfaceId));
        assertTrue(hook.supportsInterface(type(IERC165).interfaceId));
        assertFalse(hook.supportsInterface(bytes4(0xdeadbeef)));
    }
}

/// @dev R6 harness: two pre-settled swaps into the same pool inside ONE
///      PoolManager lock. Deltas are taken at the end; the unlock closes
///      clean, which asserts NonzeroDeltaCount returned to zero.
contract NestedSwapper is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager internal immutable _pm;
    GUSD internal immutable _gusd;
    IERC20 internal immutable _gpu;
    address internal immutable _ledger; // takes hook fees here (in-kind GPU)

    constructor(IPoolManager pm, GUSD gusd_, IERC20 gpu_, address ledger_) {
        _pm = pm;
        _gusd = gusd_;
        _gpu = gpu_;
        _ledger = ledger_;
    }

    function run(PoolKey memory key, bool buyZeroForOne, int256 buyAmt, int256 sellAmt)
        external
        returns (int256 gusdDelta, int256 gpuDelta)
    {
        uint256 g0 = _gusd.balanceOf(address(this));
        uint256 p0 = _gpu.balanceOf(address(this));
        _pm.unlock(abi.encode(key, buyZeroForOne, buyAmt, sellAmt));
        gusdDelta = int256(_gusd.balanceOf(address(this))) - int256(g0);
        gpuDelta = int256(_gpu.balanceOf(address(this))) - int256(p0);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, bool buyZeroForOne, int256 buyAmt, int256 sellAmt) =
            abi.decode(data, (PoolKey, bool, int256, int256));
        (Currency gCur, Currency gpuCur) = (Currency.wrap(address(_gusd)), Currency.wrap(address(_gpu)));
        // swap 1: buy exactIn, pre-settled
        _pm.sync(gCur);
        _gusd.transfer(address(_pm), uint256(-buyAmt));
        _pm.settle();
        _pm.swap(
            key,
            SwapParams({
                zeroForOne: buyZeroForOne,
                amountSpecified: buyAmt,
                sqrtPriceLimitX96: buyZeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        // swap 2: sell exactIn, pre-settled
        _pm.sync(gpuCur);
        _gpu.transfer(address(_pm), uint256(-sellAmt));
        _pm.settle();
        _pm.swap(
            key,
            SwapParams({
                zeroForOne: !buyZeroForOne,
                amountSpecified: sellAmt,
                sqrtPriceLimitX96: buyZeroForOne ? TickMath.MAX_SQRT_PRICE - 1 : TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
        // take everything the swaps credited
        int256 gDelta = _pm.currencyDelta(address(this), gCur);
        if (gDelta > 0) _pm.take(gCur, address(this), uint256(gDelta));
        int256 gpuDelta = _pm.currencyDelta(address(this), gpuCur);
        if (gpuDelta > 0) _pm.take(gpuCur, address(this), uint256(gpuDelta));
        return "";
    }
}

/// @dev Pay-then-swap direct buyer — the supported direct path (R3) and the
///      router's exact shape: the input is settled into the PM before the
///      swap (here the quoted all-in total), the output credit is taken
///      in-lock, and the unlock closes with a zero ledger.
contract PayThenSwapBuyer is IUnlockCallback {
    IPoolManager internal immutable _pm;

    constructor(IPoolManager pm) {
        _pm = pm;
    }

    function buy(PoolKey memory key, bool zeroForOne, int256 gpuOut, uint256 gusdIn, bool gIsC0) external {
        _pm.unlock(abi.encode(key, zeroForOne, gpuOut, gusdIn, gIsC0));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, bool zeroForOne, int256 gpuOut, uint256 gusdIn, bool gIsC0) =
            abi.decode(data, (PoolKey, bool, int256, uint256, bool));
        (Currency gCur, Currency gpuCur) =
            gIsC0 ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        _pm.sync(gCur);
        GUSD(Currency.unwrap(gCur)).transfer(address(_pm), gusdIn);
        _pm.settle();
        BalanceDelta delta = _pm.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: gpuOut,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        uint256 gpuOutAmt = uint256(uint128(gIsC0 ? delta.amount1() : delta.amount0()));
        if (gpuOutAmt > 0) _pm.take(gpuCur, address(this), gpuOutAmt);
        return "";
    }
}

/// Concrete orderings: every test in GPUHookTestBase runs under both.
contract GusdIsCurrency0Test is GPUHookTestBase {
    function _wantGusdIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract GusdIsCurrency1Test is GPUHookTestBase {
    function _wantGusdIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}
