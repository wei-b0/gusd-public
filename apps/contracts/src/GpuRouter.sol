// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SafeCallback} from "@uniswap/v4-periphery/base/SafeCallback.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {GUSD} from "./GUSD.sol";
import {GPUIssuance} from "./GPUIssuance.sol";
import {IGPUIssuance} from "./interfaces/IGPUIssuance.sol";
import {GPUHook} from "./hooks/GPUHook.sol";
import {GpuPoolKey} from "./libraries/GpuPoolKey.sol";

/// @title GpuRouter — the product surface: BUY GPU and SELL GPU, one tx each.
/// @notice One swap is the complete market: the hook composes native LP flow,
///         POL inventory and the in-swap issuance backstop inside every
///         canonical-pool swap. The router adds funding (pay-then-swap so the
///         hook's in-lock takes are always physically backed), slippage and
///         deadline enforcement, payout conversion (gUSD -> reserve asset),
///         and the genesis fallback: when a GPU's canonical pool is not yet
///         registered, BUY mints 100% via primary issuance (zero v4
///         dependency — a v4 problem can never fail a primary buy).
/// @dev    Settle pattern inside unlock callbacks: sync -> transfer -> settle
///         with the FULL funded balance settled before the swap. Any leg
///         reverting reverts the whole transaction: v4 transient state rolls
///         back and nothing settles early. The router never holds funds at
///         rest (asserted after every flow).
contract GpuRouter is SafeCallback, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    GUSD public immutable gUSD;
    GPUIssuance public immutable issuance;
    GPUHook public immutable hook;
    IERC20 public immutable underlying;

    uint8 private constant ACTION_BUY = 0; // exact-out GPU buy via the pool
    uint8 private constant ACTION_BUY_EXACT_IN = 1;
    uint8 private constant ACTION_SELL_EXACT_IN = 2;

    error ZeroAmount();
    error ZeroGpuOut();
    error DeadlinePassed();
    error UnknownGpu();
    error UnsupportedPayment();
    error NotCanonicalPool();
    error MaxPaidExceeded();
    error Slippage();
    error DustLeft();

    /// @notice BUY filled through the canonical pool (native + POL + backstop
    ///         — the hook's GpuFill events decompose the sources). `paid` =
    ///         gUSD-equivalent spent.
    event Buy(
        bytes32 indexed gpuId,
        address indexed recipient,
        address indexed payer,
        uint256 gpuOut,
        uint256 paid,
        uint256 polFeeGusd,
        uint256 hookFeeGusd,
        uint256 issuanceFee
    );

    /// @notice SELL filled through the canonical pool; `out` = payout units
    ///         delivered (gUSD or reserve asset).
    event Sell(
        bytes32 indexed gpuId,
        address indexed recipient,
        uint256 gpuIn,
        uint256 out,
        uint256 polFeeGusd,
        uint256 hookFeeGusd
    );

    struct BuyParams {
        bytes32 gpuId;
        uint256 gpuOut; // total GPU tokens the recipient must receive
        address payment; // the reserve asset (underlying) or gUSD
        uint256 maxPaid; // gUSD-equivalent spend cap
        uint256 deadline; // 0 = no deadline
        uint160 sqrtLimitX96; // 0 = wide
        address recipient; // 0 = msg.sender
    }

    struct SellParams {
        bytes32 gpuId;
        uint256 gpuIn;
        address payout; // the reserve asset (underlying) or gUSD
        uint256 minOut; // in payout units
        uint256 deadline; // 0 = no deadline
        uint160 sqrtLimitX96; // 0 = wide
        address recipient; // 0 = msg.sender
    }

    constructor(IPoolManager poolManager_, GUSD gUSD_, GPUIssuance issuance_, GPUHook hook_)
        SafeCallback(poolManager_)
    {
        gUSD = gUSD_;
        issuance = issuance_;
        hook = hook_;
        underlying = gUSD_.underlying();
        // Approvals: issuance pulls gUSD from the router only in the genesis
        // fallback (issue() transferFrom); GUSD pulls the reserve asset on
        // mint. No PoolManager approval: settlement is sync -> direct
        // transfer -> settle, and hook takes draw on PM reserves. The router
        // never holds funds at rest (asserted on every flow).
        IERC20(address(gUSD_)).forceApprove(address(issuance_), type(uint256).max);
        underlying.forceApprove(address(gUSD_), type(uint256).max);
    }

    // ----------------------------------------------------------------- BUY

    /// @notice BUY `gpuOut` GPU tokens for at most `maxPaid` (gUSD-equivalent)
    ///         through the canonical pool — the hook fills native LP flow,
    ///         POL inventory and the issuance backstop inside the single
    ///         swap. When the pool is not registered (genesis market), mints
    ///         100% via primary issuance. Unconsumed funds are refunded.
    function buy(BuyParams calldata p) external nonReentrant returns (uint256 paid) {
        if (p.gpuOut == 0) revert ZeroGpuOut();
        _checkDeadline(p.deadline);
        address gpuToken = issuance.tokenOf(p.gpuId);
        if (gpuToken == address(0)) revert UnknownGpu();
        PoolKey memory key = _canonicalKey(p.gpuId);
        address recipient = p.recipient == address(0) ? msg.sender : p.recipient;

        // 1) fund: pull maxPaid, escrowing it as gUSD on the router. Any leg
        //    reverting reverts the whole tx, so the escrow is always transient.
        uint256 funded;
        if (p.payment == address(gUSD)) {
            IERC20(address(gUSD)).safeTransferFrom(msg.sender, address(this), p.maxPaid);
            funded = p.maxPaid;
        } else if (p.payment == address(underlying)) {
            // maxPaid is gUSD-equivalent: gross up for the mint fee so the
            // minted gUSD covers it (mirrors sell()'s redeem-fee gross-up);
            // the surplus rides in `funded` and refunds as change below
            uint256 gross = Math.mulDiv(p.maxPaid, 10_000, 10_000 - gUSD.mintFeeBps(), Math.Rounding.Ceil);
            IERC20(p.payment).safeTransferFrom(msg.sender, address(this), gross);
            funded = gUSD.mint(gross, address(this));
        } else {
            revert UnsupportedPayment();
        }

        // 2) genesis fallback: unregistered pool => 100% issuance, zero v4.
        if (hook.poolGpuId(key.toId()) == bytes32(0)) {
            (, uint256 issuanceFee) = issuance.issue(p.gpuId, p.gpuOut, recipient);
            if (IERC20(gpuToken).balanceOf(address(this)) != 0) revert DustLeft();
            uint256 change0 = IERC20(address(gUSD)).balanceOf(address(this));
            if (change0 > 0) IERC20(address(gUSD)).safeTransfer(recipient, change0);
            emit Buy(p.gpuId, recipient, msg.sender, p.gpuOut, funded - change0, 0, 0, issuanceFee);
            return funded - change0;
        }

        // 3) single pool swap: the hook composes native + POL + backstop.
        (uint256 polFee, uint256 hookFee) = _feesSnapshot();
        poolManager.unlock(abi.encode(ACTION_BUY, key, p.gpuOut, p.sqrtLimitX96, recipient));
        (polFee, hookFee) = _feesSnapshotDelta(polFee, hookFee);

        // 4) refund the unconsumed balance; the router never holds funds.
        uint256 change = IERC20(address(gUSD)).balanceOf(address(this));
        paid = funded - change;
        if (change > 0) IERC20(address(gUSD)).safeTransfer(recipient, change);
        if (IERC20(address(gUSD)).balanceOf(address(this)) != 0) revert DustLeft();
        if (IERC20(gpuToken).balanceOf(address(this)) != 0) revert DustLeft();

        emit Buy(p.gpuId, recipient, msg.sender, p.gpuOut, paid, polFee, hookFee, 0);
    }

    /// @notice Pool-only BUY: spend exactly `gusdMaxIn` gUSD, receive at
    ///         least `minGpuOut` GPU. All-or-nothing: a market with no
    ///         capacity for the tail reverts InsufficientMarketCapacity
    ///         (from the hook) — the honest "market closed at this size".
    function buyExactIn(
        bytes32 gpuId,
        uint256 gusdMaxIn,
        uint256 minGpuOut,
        uint256 deadline,
        uint160 sqrtLimitX96,
        address recipient
    ) external nonReentrant returns (uint256 gpuOut) {
        if (gusdMaxIn == 0) revert ZeroAmount();
        _checkDeadline(deadline);
        PoolKey memory key = _canonicalKey(gpuId);
        if (hook.poolGpuId(key.toId()) == bytes32(0)) revert NotCanonicalPool();
        address gpuToken = Currency.unwrap(_gpuCurrency(key));
        address to = recipient == address(0) ? msg.sender : recipient;

        IERC20(address(gUSD)).safeTransferFrom(msg.sender, address(this), gusdMaxIn);

        (uint256 polFee, uint256 hookFee) = _feesSnapshot();
        bytes memory ret = poolManager.unlock(
            abi.encode(ACTION_BUY_EXACT_IN, key, gpuToken, gusdMaxIn, minGpuOut, sqrtLimitX96, to)
        );
        (polFee, hookFee) = _feesSnapshotDelta(polFee, hookFee);
        gpuOut = abi.decode(ret, (uint256));

        if (IERC20(address(gUSD)).balanceOf(address(this)) != 0) revert DustLeft();
        if (IERC20(gpuToken).balanceOf(address(this)) != 0) revert DustLeft();

        emit Buy(gpuId, to, msg.sender, gpuOut, gusdMaxIn, polFee, hookFee, 0);
    }

    // ---------------------------------------------------------------- SELL

    /// @notice SELL `gpuIn` GPU tokens for at least `minOut` in `payout`
    ///         (gUSD or the reserve asset). Pure secondary execution —
    ///         proceeds come from native LPs and the POL bid inventory; the
    ///         issuance and the oracle are untouched by sells.
    function sell(SellParams calldata p) external nonReentrant returns (uint256 out) {
        if (p.gpuIn == 0) revert ZeroAmount();
        _checkDeadline(p.deadline);
        PoolKey memory key = _canonicalKey(p.gpuId);
        if (hook.poolGpuId(key.toId()) == bytes32(0)) revert NotCanonicalPool();
        address gpuToken = Currency.unwrap(_gpuCurrency(key));
        address to = p.recipient == address(0) ? msg.sender : p.recipient;

        // gUSD needed so the payout bound holds after the redeem fee
        uint256 requiredGusd = p.minOut;
        if (p.payout == address(underlying)) {
            requiredGusd = Math.mulDiv(p.minOut, 10_000, 10_000 - gUSD.redeemFeeBps(), Math.Rounding.Ceil);
        } else if (p.payout != address(gUSD)) {
            revert UnsupportedPayment();
        }

        IERC20(gpuToken).safeTransferFrom(msg.sender, address(this), p.gpuIn);

        (uint256 polFee, uint256 hookFee) = _feesSnapshot();
        bytes memory ret = poolManager.unlock(
            abi.encode(ACTION_SELL_EXACT_IN, key, gpuToken, p.gpuIn, requiredGusd, p.sqrtLimitX96, to, msg.sender)
        );
        (polFee, hookFee) = _feesSnapshotDelta(polFee, hookFee);
        uint256 gusdNet = abi.decode(ret, (uint256));

        if (p.payout == address(gUSD)) {
            IERC20(address(gUSD)).safeTransfer(to, gusdNet);
            out = gusdNet;
        } else {
            out = gUSD.redeem(gusdNet, to);
        }
        if (IERC20(address(gUSD)).balanceOf(address(this)) != 0) revert DustLeft();
        if (IERC20(gpuToken).balanceOf(address(this)) != 0) revert DustLeft();

        emit Sell(p.gpuId, to, p.gpuIn, out, polFee, hookFee);
    }

    // ----------------------------------------------------- unlock callbacks

    function _unlockCallback(bytes calldata data) internal override returns (bytes memory) {
        uint8 action = abi.decode(data[:32], (uint8));

        if (action == ACTION_BUY) {
            (, PoolKey memory key, uint256 gpuOut, uint160 sqrtLimit, address recipient) =
                abi.decode(data, (uint8, PoolKey, uint256, uint160, address));

            // Pay-then-swap: settle the router's FULL gUSD balance first so
            // the hook's inside-swap takes can never fail for reserves.
            uint256 gusdAvailable = IERC20(address(gUSD)).balanceOf(address(this));
            _settleGusd();
            bool zeroForOne = _buyZeroForOne(key);
            BalanceDelta delta = poolManager.swap(
                key,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: int256(gpuOut), // exact-out: GPU demanded
                    sqrtPriceLimitX96: _limit(zeroForOne, sqrtLimit)
                }),
                ""
            );

            // exactOut delivers the demanded amount or reverts; the caller's
            // gUSD delta covers native input + hook charge + hook fee.
            int256 gusdOwed = zeroForOne ? delta.amount0() : delta.amount1(); // negative
            uint256 owed = uint256(-gusdOwed);
            if (owed > gusdAvailable) revert MaxPaidExceeded();
            uint256 change = gusdAvailable - owed;

            Currency gpuCur = _gpuCurrency(key);
            _managerTake(Currency.unwrap(gpuCur), recipient, gpuOut);
            Currency gusdCur = zeroForOne ? key.currency0 : key.currency1;
            if (change > 0) _managerTake(Currency.unwrap(gusdCur), address(this), change);
            return abi.encode(gpuOut);
        }

        if (action == ACTION_BUY_EXACT_IN) {
            (, PoolKey memory key, address gpuToken, uint256 gusdMaxIn, uint256 minGpuOut, uint160 sqrtLimit, address to) =
                abi.decode(data, (uint8, PoolKey, address, uint256, uint256, uint160, address));

            _settleGusd();
            bool zeroForOne = _buyZeroForOne(key);
            BalanceDelta delta = poolManager.swap(
                key,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: -int256(gusdMaxIn), // exact-in
                    sqrtPriceLimitX96: _limit(zeroForOne, sqrtLimit)
                }),
                ""
            );

            uint256 gpuOut = uint256(uint128(zeroForOne ? delta.amount1() : delta.amount0()));
            if (gpuOut < minGpuOut) revert Slippage();
            // the caller's gUSD ledger nets to exactly zero: settle(+maxIn)
            // vs native + hook consumption of the full amount (absorb identity)
            _managerTake(gpuToken, to, gpuOut);
            return abi.encode(gpuOut);
        }

        // ACTION_SELL_EXACT_IN
        (
            ,
            PoolKey memory key,
            address gpuToken,
            uint256 gpuIn,
            uint256 requiredGusd,
            uint160 sqrtLimit,
            address to,
            address seller
        ) = abi.decode(data, (uint8, PoolKey, address, uint256, uint256, uint160, address, address));

        _settleGpu(gpuToken, gpuIn);
        bool zeroForOne = !_buyZeroForOne(key); // GPU -> gUSD
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(gpuIn), // exact-in
                sqrtPriceLimitX96: _limit(zeroForOne, sqrtLimit)
            }),
            ""
        );

        // gUSD is the currency received (positive), GPU the one spent (neg.)
        int256 gusdDelta = _buyZeroForOne(key) ? delta.amount0() : delta.amount1();
        uint256 gusdNet = uint256(gusdDelta);
        if (gusdNet < requiredGusd) revert Slippage();
        _managerTake(address(gUSD), address(this), gusdNet);

        // unconsumed GPU input (caller sqrtLimit partial fill) returns to seller
        int256 gpuDelta = _buyZeroForOne(key) ? delta.amount1() : delta.amount0();
        uint256 consumed = uint256(-gpuDelta);
        if (consumed < gpuIn) _managerTake(gpuToken, seller, gpuIn - consumed);

        return abi.encode(gusdNet);
    }

    // -------------------------------------------------------------- helpers

    function _checkDeadline(uint256 deadline) internal view {
        if (deadline != 0 && block.timestamp > deadline) revert DeadlinePassed();
    }

    /// @dev Hook counter deltas (totalPolFeesGusd, totalHookFeesGusd) around
    ///      the unlock — POL notional is not charged to the user, so only the
    ///      fee counters are event-relevant.
    function _feesSnapshot() internal view returns (uint256 polFee, uint256 hookFee) {
        return (hook.totalPolFeesGusd(), hook.totalHookFeesGusd());
    }

    function _feesSnapshotDelta(uint256 polBefore, uint256 hookBefore)
        internal
        view
        returns (uint256 polFee, uint256 hookFee)
    {
        return (hook.totalPolFeesGusd() - polBefore, hook.totalHookFeesGusd() - hookBefore);
    }

    /// @dev sync -> direct transfer -> settle. settle() credits the router's
    ///      ledger with exactly what arrived, so no PM approval is needed.
    function _settleGusd() internal {
        Currency g = Currency.wrap(address(gUSD));
        poolManager.sync(g);
        CurrencyLibrary.transfer(g, address(poolManager), IERC20(address(gUSD)).balanceOf(address(this)));
        poolManager.settle();
    }

    function _settleGpu(address gpuToken, uint256 amount) internal {
        Currency c = Currency.wrap(gpuToken);
        poolManager.sync(c);
        CurrencyLibrary.transfer(c, address(poolManager), amount);
        poolManager.settle();
    }

    /// @dev poolManager.take transfers real PM reserves and debits the
    ///      router's caller ledger — usable mid-lock without approvals.
    function _managerTake(address token, address to, uint256 amount) internal {
        poolManager.take(Currency.wrap(token), to, amount);
    }

    /// @dev 0 = wide default on the correct side of the current price.
    function _limit(bool zeroForOne, uint160 sqrtLimit) internal pure returns (uint160) {
        if (sqrtLimit != 0) return sqrtLimit;
        return zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
    }

    /// @dev BUY = gUSD -> GPU: zeroForOne iff gUSD is currency0.
    function _buyZeroForOne(PoolKey memory key) internal view returns (bool) {
        return GpuPoolKey.gusdIsCurrency0(key, address(gUSD));
    }

    function _gpuCurrency(PoolKey memory key) internal view returns (Currency) {
        return _buyZeroForOne(key) ? key.currency1 : key.currency0;
    }

    function _canonicalKey(bytes32 gpuId) internal view returns (PoolKey memory key) {
        address gpuToken = issuance.tokenOf(gpuId);
        IGPUIssuance.PoolParams memory pp = issuance.poolParamsOf(gpuId);
        key = GpuPoolKey.canonical(address(gUSD), gpuToken, pp, hook);
    }
}
