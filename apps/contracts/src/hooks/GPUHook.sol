// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IGPUIssuance} from "../interfaces/IGPUIssuance.sol";

/// @title GPUHook — canonical GPU/gUSD pool gatekeeper + gUSD trading-fee capture.
/// @notice Permissions: afterInitialize, beforeSwap, afterSwap (+ both swap
///         return-delta flags). The pool cannot exist unless it matches the
///         canonical GPU configuration. Every swap in a canonical pool pays a
///         protocol trading fee of `hookFeeBps` on the gUSD LEG of the trade,
///         so the protocol share is gUSD-denominated in BOTH directions:
///         BUY (gUSD -> GPU) is charged on the gUSD input, SELL (GPU -> gUSD)
///         on the gUSD output. The LP pool fee (key.fee) is untouched and
///         accrues to LPs independently — the two revenues are separately
///         observable from the same trade (this contract's TradingFeeAccrued
///         events vs the pool's feeGrowth).
/// @dev    Fee realization (v4 cannot leave hook credits outstanding across
///         an unlock): where gUSD is the specified currency the fee is taken
///         up-front as a positive beforeSwap delta; where gUSD is the
///         unspecified currency the fee is `manager.take`n inside afterSwap
///         with a matching positive return delta (the canonical FeeTakingHook
///         pattern). Fees are recomputed purely from `params`/`swapDelta` —
///         no transient state, safe under nested swaps.
///
///         Fee matrix (specified = input when exact-in, output when exact-out):
///         | shape        | gUSD side   | mechanism                        | basis              |
///         | BUY exact-in | specified   | beforeSwap +deltaSpecified       | gross gUSD input   |
///         | SELL exact-out | specified | beforeSwap +deltaSpecified       | requested gUSD out |
///         | BUY exact-out  | unspecified | afterSwap take + return delta  | raw gUSD paid      |
///         | SELL exact-in  | unspecified | afterSwap take + return delta  | raw gUSD received  |
///         The two specified-side shapes are all-or-nothing: afterSwap reverts
///         PartialFillNotSupported unless the pool fully filled, because the
///         fee is committed before the pool math runs and cannot be refunded.
contract GPUHook is IHooks, Ownable2Step {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    uint16 public constant MAX_HOOK_FEE_BPS = 1_000; // 10% cap
    uint16 public constant DEFAULT_HOOK_FEE_BPS = 50; // 0.50%

    IPoolManager public immutable poolManager;
    address public immutable gUSD;
    IGPUIssuance public immutable issuance;
    address public immutable revenueLedger;

    uint16 public hookFeeBps;

    mapping(PoolId => bytes32) public poolGpuId;
    mapping(PoolId => uint256) public poolTradingFeesAccrued;
    mapping(PoolId => uint256) public poolTradingFeesHarvested;
    uint256 public totalTradingFeesAccrued;
    uint256 public totalTradingFeesHarvested;

    error NotPoolManager();
    error NotCanonicalPool();
    error PoolAlreadyRegistered();
    error FeeTooLarge();
    error FeeExceedsSwap();
    error PartialFillNotSupported();
    error HarvestExceedsPending();

    event PoolRegistered(PoolId indexed poolId, bytes32 indexed gpuId);
    event TradingFeeAccrued(PoolId indexed poolId, bytes32 indexed gpuId, bool indexed isBuy, uint256 gusdFee);
    event TradingFeesHarvested(PoolId indexed poolId, uint256 amount);
    event HookFeeBpsSet(uint16 oldFeeBps, uint16 newFeeBps);

    constructor(
        IPoolManager poolManager_,
        address gUSD_,
        IGPUIssuance issuance_,
        address revenueLedger_,
        address initialOwner
    ) Ownable(initialOwner) {
        poolManager = poolManager_;
        gUSD = gUSD_;
        issuance = issuance_;
        revenueLedger = revenueLedger_;
        hookFeeBps = DEFAULT_HOOK_FEE_BPS;
        Hooks.validateHookPermissions(
            this,
            Hooks.Permissions({
                beforeInitialize: false,
                afterInitialize: true,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: true,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: true,
                afterSwapReturnDelta: true,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
    }

    // ---------------------------------------------------------- hook logic

    /// @notice Validates the pool against the canonical GPU config and
    ///         registers it. The native protocol fee is deliberately NOT set:
    ///         core accrues it in the swap input currency, which on SELL would
    ///         be GPU tokens — all protocol revenue is captured below instead.
    function afterInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96, int24 tick)
        external
        override
        onlyPoolManager
        returns (bytes4)
    {
        sender; // unused
        sqrtPriceX96;
        tick;
        if (key.hooks != IHooks(this)) revert NotCanonicalPool();

        // Exactly one currency must be gUSD; the other must be a registered GPU token.
        bool gIsC0 = Currency.unwrap(key.currency0) == gUSD;
        bool gIsC1 = Currency.unwrap(key.currency1) == gUSD;
        if (gIsC0 == gIsC1) revert NotCanonicalPool(); // both or neither
        address gpuToken = gIsC0 ? Currency.unwrap(key.currency1) : Currency.unwrap(key.currency0);
        bytes32 gpuId = issuance.gpuIdOfToken(gpuToken);
        if (gpuId == bytes32(0)) revert NotCanonicalPool();

        // Pool params must match the canonical config for this GPU.
        IGPUIssuance.PoolParams memory pp = issuance.poolParamsOf(gpuId);
        if (key.fee != pp.fee || key.tickSpacing != pp.tickSpacing) revert NotCanonicalPool();

        PoolId poolId = key.toId();
        if (poolGpuId[poolId] != bytes32(0)) revert PoolAlreadyRegistered();
        poolGpuId[poolId] = gpuId;

        emit PoolRegistered(poolId, gpuId);
        return IHooks.afterInitialize.selector;
    }

    /// @notice Charges the trading fee up front when gUSD is the specified
    ///         currency (BUY exact-in: pool swaps N - fee; SELL exact-out:
    ///         pool produces N + fee). The credit is realized in afterSwap.
    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        override
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        uint256 fee = _specifiedSideFee(key, params);
        if (fee == 0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
    }

    /// @notice Captures the trading fee when gUSD is the unspecified currency
    ///         (BUY exact-out: fee comes off the gUSD paid; SELL exact-in: off
    ///         the gUSD received). For gUSD-specified swaps it realizes the
    ///         beforeSwap credit and enforces full fills.
    function afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta swapDelta,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, int128) {
        bool exactIn = params.amountSpecified < 0;
        bool gIsC0 = Currency.unwrap(key.currency0) == gUSD;
        // swapDelta is the raw pool result from the swapper's perspective
        // (input negative, output positive); int128->int256 sign-extends.
        int256 gAmt = gIsC0 ? int256(swapDelta.amount0()) : int256(swapDelta.amount1());

        if (_gusdIsSpecified(key, params)) {
            // Fee was credited in beforeSwap: realize it, and reject partial
            // fills (the upfront charge cannot be refunded in this currency).
            uint256 basis = exactIn ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
            uint256 fee = _feeFor(basis);
            if (exactIn) {
                // BUY exact-in: the pool must have consumed exactly basis - fee.
                if (uint256(-gAmt) != basis - fee) revert PartialFillNotSupported();
            } else {
                // SELL exact-out: the pool must have delivered exactly basis + fee.
                if (uint256(gAmt) != basis + fee) revert PartialFillNotSupported();
            }
            if (fee > 0) _accrue(key, fee, exactIn);
            return (IHooks.afterSwap.selector, 0);
        }

        // gUSD unspecified: the raw gUSD leg is the fee basis.
        uint256 rawGusd = gAmt < 0 ? uint256(-gAmt) : uint256(gAmt);
        if (rawGusd == 0) return (IHooks.afterSwap.selector, 0);
        uint256 feeAfter = _feeFor(rawGusd);
        if (feeAfter == 0) return (IHooks.afterSwap.selector, 0);
        // Realize: take gUSD out of the pool into this hook (_accrue), and
        // debit the swapper via a matching positive unspecified-side return
        // delta so the hook's manager delta nets back to zero.
        _accrue(key, feeAfter, exactIn);
        return (IHooks.afterSwap.selector, int128(int256(feeAfter)));
    }

    // -------------------------------------------------------- fee accounting

    /// @dev gUSD is the specified currency iff the swap commits in gUSD:
    ///      BUY exact-in (gUSD input) and SELL exact-out (gUSD output).
    function _gusdIsSpecified(PoolKey calldata key, SwapParams calldata params) internal view returns (bool) {
        bool exactIn = params.amountSpecified < 0;
        Currency specified = (params.zeroForOne == exactIn) ? key.currency0 : key.currency1;
        return Currency.unwrap(specified) == gUSD;
    }

    function _specifiedSideFee(PoolKey calldata key, SwapParams calldata params) internal view returns (uint256 fee) {
        if (!_gusdIsSpecified(key, params)) return 0;
        uint256 basis = params.amountSpecified < 0 ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        fee = _feeFor(basis);
        // A fee >= the gUSD leg would zero out (or invert) the pool swap; dust
        // trades revert instead of silently paying a 100% fee.
        if (fee >= basis) revert FeeExceedsSwap();
    }

    function _feeFor(uint256 basis) internal view returns (uint256) {
        return Math.mulDiv(basis, hookFeeBps, 10_000, Math.Rounding.Ceil);
    }

    /// @dev Physical realization + per-trade observability. Called inside the
    ///      swap (lock held): take debits the hook's manager delta, which the
    ///      return delta (unspecified side) or the beforeSwap credit re-credits.
    function _accrue(PoolKey calldata key, uint256 fee, bool isBuy) internal {
        PoolId poolId = key.toId();
        bytes32 gpuId = poolGpuId[poolId];
        poolTradingFeesAccrued[poolId] += fee;
        totalTradingFeesAccrued += fee;
        poolManager.take(Currency.wrap(gUSD), address(this), fee);
        emit TradingFeeAccrued(poolId, gpuId, isBuy, fee);
    }

    // ------------------------------------------------------ revenue harvest

    /// @notice Permissionless: moves `amount` (0 = all pending) of this pool's
    ///         accrued trading fees to the RevenueLedger. Moves the tracked
    ///         counter, never the raw balance, so gUSD donated directly to the
    ///         hook can never be harvested as revenue. Callable outside any
    ///         lock; safe inside one too (plain ERC20 transfer).
    function harvestTradingFees(PoolId poolId, uint256 amount) external {
        uint256 pending = poolTradingFeesAccrued[poolId] - poolTradingFeesHarvested[poolId];
        uint256 amt = amount == 0 ? pending : amount;
        if (amt > pending) revert HarvestExceedsPending();
        if (amt == 0) return;
        poolTradingFeesHarvested[poolId] += amt;
        totalTradingFeesHarvested += amt;
        IERC20(gUSD).safeTransfer(revenueLedger, amt);
        emit TradingFeesHarvested(poolId, amt);
    }

    function pendingTradingFees(PoolId poolId) external view returns (uint256) {
        return poolTradingFeesAccrued[poolId] - poolTradingFeesHarvested[poolId];
    }

    function setHookFeeBps(uint16 feeBps) external onlyOwner {
        if (feeBps > MAX_HOOK_FEE_BPS) revert FeeTooLarge();
        emit HookFeeBpsSet(hookFeeBps, feeBps);
        hookFeeBps = feeBps;
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    // Remaining IHooks entry points: never called (permissions false), but must
    // exist so the contract is concrete.
    function beforeInitialize(address, PoolKey calldata, uint160) external pure override returns (bytes4) {
        revert NotCanonicalPool();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert NotCanonicalPool();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert NotCanonicalPool();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert NotCanonicalPool();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert NotCanonicalPool();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert NotCanonicalPool();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert NotCanonicalPool();
    }
}
