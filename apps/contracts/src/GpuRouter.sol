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
import {IMarketLiquidity} from "./interfaces/IMarketLiquidity.sol";
import {GPUHook} from "./hooks/GPUHook.sol";
import {GpuPoolKey} from "./libraries/GpuPoolKey.sol";

/// @title GpuRouter — the product surface: BUY GPU and SELL GPU, one tx each.
/// @notice Hides gUSD mechanics, primary issuance, Uniswap v4 routing, LP and
///         protocol fee plumbing behind two actions:
///         - buy(): exact GPU out, funded with the reserve asset (gUSD's
///           `underlying`) or gUSD, filled by a canonical-pool swap and/or
///           primary issuance. Genesis markets have zero circulating supply,
///           so early BUYs are 100% issuance with no pool involved.
///         - buyExactIn(): spend an exact gUSD amount into the pool (the
///           "spend up to X" entrypoint; the hook enforces all-or-nothing).
///         - sell(): exact GPU in, proceeds in gUSD or the reserve asset.
///           Pure secondary execution — no NAV redemption exists
///           (PROTOCOL.md section 8).
/// @dev    Settle pattern inside unlock callbacks: sync -> transfer -> settle,
///         with the FULL funded balance settled before the swap (pay-then-
///         swap) so the hook's inside-swap fee take can never fail for
///         reserves. Any leg reverting reverts the whole transaction: v4
///         transient state rolls back and nothing settles early. GUSD paused
///         => reserve-asset legs revert; gUSD-direct paths still work.
contract GpuRouter is SafeCallback, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    GUSD public immutable gUSD;
    GPUIssuance public immutable issuance;
    GPUHook public immutable hook;
    IERC20 public immutable underlying;

    uint8 private constant ACTION_BUY_POOL = 0;
    uint8 private constant ACTION_BUY_EXACT_IN = 1;
    uint8 private constant ACTION_SELL_EXACT_IN = 2;

    error ZeroAmount();
    error ZeroGpuOut();
    error LegMismatch();
    error UnknownGpu();
    error UnsupportedPayment();
    error NotCanonicalPool();
    error MaxPaidExceeded();
    error PoolShortfall();
    error Slippage();
    error DustLeft();

    /// @notice Full fee breakdown of a BUY: `paid` = gUSD-equivalent spent,
    ///         `hookFee` = protocol trading fee on the pool leg (gUSD),
    ///         `issuanceFee` = primary issuance fee (gUSD). LP pool fees are
    ///         observable separately on the pool (feeGrowth).
    event Buy(
        bytes32 indexed gpuId,
        address indexed recipient,
        address indexed payer,
        uint256 gpuOut,
        uint256 paid,
        uint256 poolGpuOut,
        uint256 issueGpuOut,
        uint256 hookFee,
        uint256 issuanceFee
    );

    /// @notice Full fee breakdown of a SELL: `out` = payout units delivered
    ///         (gUSD or USDC), `hookFee` = protocol trading fee (gUSD).
    event Sell(bytes32 indexed gpuId, address indexed recipient, uint256 gpuIn, uint256 out, uint256 hookFee);

    struct BuyParams {
        bytes32 gpuId;
        uint256 gpuOut; // total GPU tokens the recipient must receive
        uint256 poolGpuOut; // portion filled from the canonical pool
        uint256 issueGpuOut; // portion minted via primary issuance
        address payment; // the reserve asset (underlying) or gUSD
        uint256 maxPaid; // gUSD-equivalent spend cap
        uint160 sqrtLimitX96; // 0 = wide
        address recipient; // 0 = msg.sender
    }

    struct SellParams {
        bytes32 gpuId;
        uint256 gpuIn;
        address payout; // the reserve asset (underlying) or gUSD
        uint256 minOut; // in payout units
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
        // The manager pulls gUSD only via router-initiated settle(); issuance
        // pulls gUSD for the issuance leg; GUSD pulls the reserve asset on
        // mint. Max approvals are safe: the router never holds funds at rest
        // (asserted on every flow).
        IERC20(address(gUSD_)).forceApprove(address(poolManager_), type(uint256).max);
        IERC20(address(gUSD_)).forceApprove(address(issuance_), type(uint256).max);
        underlying.forceApprove(address(gUSD_), type(uint256).max);
    }

    // ----------------------------------------------------------------- BUY

    /// @notice BUY `gpuOut` GPU tokens for at most `maxPaid` (gUSD-equivalent),
    ///         filled by pool swap (`poolGpuOut`) and/or primary issuance
    ///         (`issueGpuOut`, priced at oracle + issuance fee at execution).
    ///         Genesis: `poolGpuOut = 0` mints 100% via issuance; no pool
    ///         needs to exist. Unconsumed funds are refunded to `recipient`.
    function buy(BuyParams calldata p) external nonReentrant returns (uint256 paid) {
        if (p.gpuOut == 0) revert ZeroGpuOut();
        if (p.poolGpuOut + p.issueGpuOut != p.gpuOut) revert LegMismatch();
        address gpuToken = issuance.tokenOf(p.gpuId);
        if (gpuToken == address(0)) revert UnknownGpu();
        address recipient = p.recipient == address(0) ? msg.sender : p.recipient;

        // 1) fund: pull `maxPaid`, holding it as gUSD on the router.
        if (p.payment == address(gUSD)) {
            IERC20(address(gUSD)).safeTransferFrom(msg.sender, address(this), p.maxPaid);
        } else if (p.payment == address(underlying)) {
            IERC20(p.payment).safeTransferFrom(msg.sender, address(this), p.maxPaid);
            // nets the mint fee; the minted amount is what is available
            gUSD.mint(p.maxPaid, address(this));
        } else {
            revert UnsupportedPayment();
        }

        // 2) pool leg (skipped entirely for genesis / issuance-only BUYs)
        uint256 hookFee;
        if (p.poolGpuOut > 0) {
            PoolKey memory key = _canonicalKey(p.gpuId);
            if (hook.poolGpuId(key.toId()) == bytes32(0)) revert NotCanonicalPool();
            uint256 accruedBefore = hook.totalTradingFeesAccrued();
            poolManager.unlock(abi.encode(ACTION_BUY_POOL, key, gpuToken, p.poolGpuOut, p.sqrtLimitX96, recipient));
            hookFee = hook.totalTradingFeesAccrued() - accruedBefore;
        }

        // 3) issuance leg: oracle-priced, mints straight to the recipient.
        //    Best-effort placement: the principal just contributed pends in
        //    the POL and the router attempts deployPending so normal latency
        //    is ~zero; a failed attempt leaves it pending (self-healing via
        //    the next buy or a keeper — pending is state, not loss).
        uint256 issuanceFee;
        if (p.issueGpuOut > 0) {
            (, issuanceFee) = issuance.issue(p.gpuId, p.issueGpuOut, recipient);
            try IMarketLiquidity(issuance.marketLiquidity()).deployPending(p.gpuId) {} catch {}
        }

        // 4) refund the unconsumed balance; the router never holds funds.
        uint256 change = IERC20(address(gUSD)).balanceOf(address(this));
        paid = p.maxPaid - change;
        if (change > 0) IERC20(address(gUSD)).safeTransfer(recipient, change);
        if (IERC20(address(gUSD)).balanceOf(address(this)) != 0) revert DustLeft();
        if (IERC20(gpuToken).balanceOf(address(this)) != 0) revert DustLeft();

        emit Buy(p.gpuId, recipient, msg.sender, p.gpuOut, paid, p.poolGpuOut, p.issueGpuOut, hookFee, issuanceFee);
    }

    /// @notice Pool-only BUY: spend exactly `gusdMaxIn` gUSD, receive at
    ///         least `minGpuOut` GPU. All-or-nothing: if the pool cannot
    ///         absorb the full amount the hook reverts PartialFillNotSupported.
    function buyExactIn(bytes32 gpuId, uint256 gusdMaxIn, uint256 minGpuOut, uint160 sqrtLimitX96, address recipient)
        external
        nonReentrant
        returns (uint256 gpuOut)
    {
        if (gusdMaxIn == 0) revert ZeroAmount();
        PoolKey memory key = _canonicalKey(gpuId);
        if (hook.poolGpuId(key.toId()) == bytes32(0)) revert NotCanonicalPool();
        address gpuToken = Currency.unwrap(_gpuCurrency(key));
        address to = recipient == address(0) ? msg.sender : recipient;

        IERC20(address(gUSD)).safeTransferFrom(msg.sender, address(this), gusdMaxIn);

        uint256 accruedBefore = hook.totalTradingFeesAccrued();
        bytes memory ret =
            poolManager.unlock(abi.encode(ACTION_BUY_EXACT_IN, key, gpuToken, gusdMaxIn, minGpuOut, sqrtLimitX96, to));
        uint256 hookFee = hook.totalTradingFeesAccrued() - accruedBefore;
        gpuOut = abi.decode(ret, (uint256));

        if (IERC20(address(gUSD)).balanceOf(address(this)) != 0) revert DustLeft();
        if (IERC20(gpuToken).balanceOf(address(this)) != 0) revert DustLeft();

        emit Buy(gpuId, to, msg.sender, gpuOut, gusdMaxIn, gpuOut, 0, hookFee, 0);
    }

    // ---------------------------------------------------------------- SELL

    /// @notice SELL `gpuIn` GPU tokens for at least `minOut` in `payout`
    ///         (gUSD or USDC). Pure secondary execution — proceeds come from
    ///         pool liquidity (POL bands + external LPs); issuance and the
    ///         oracle are untouched.
    function sell(SellParams calldata p) external nonReentrant returns (uint256 out) {
        if (p.gpuIn == 0) revert ZeroAmount();
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
        IERC20(gpuToken).forceApprove(address(poolManager), p.gpuIn);

        uint256 accruedBefore = hook.totalTradingFeesAccrued();
        bytes memory ret = poolManager.unlock(
            abi.encode(ACTION_SELL_EXACT_IN, key, gpuToken, p.gpuIn, requiredGusd, p.sqrtLimitX96, to, msg.sender)
        );
        uint256 hookFee = hook.totalTradingFeesAccrued() - accruedBefore;
        uint256 gusdNet = abi.decode(ret, (uint256));

        if (p.payout == address(gUSD)) {
            IERC20(address(gUSD)).safeTransfer(to, gusdNet);
            out = gusdNet;
        } else {
            out = gUSD.redeem(gusdNet, to);
        }
        if (IERC20(address(gUSD)).balanceOf(address(this)) != 0) revert DustLeft();
        if (IERC20(gpuToken).balanceOf(address(this)) != 0) revert DustLeft();

        emit Sell(p.gpuId, to, p.gpuIn, out, hookFee);
    }

    // ----------------------------------------------------- unlock callbacks

    function _unlockCallback(bytes calldata data) internal override returns (bytes memory) {
        uint8 action = abi.decode(data[:32], (uint8));

        if (action == ACTION_BUY_POOL) {
            (, PoolKey memory key, address gpuToken, uint256 gpuOut, uint160 sqrtLimit, address recipient) =
                abi.decode(data, (uint8, PoolKey, address, uint256, uint160, address));

            // Pay-then-swap: settle the router's FULL gUSD balance first so
            // the hook's inside-swap fee take can never fail for reserves.
            uint256 gusdAvailable = IERC20(address(gUSD)).balanceOf(address(this));
            _settleGusd();
            bool zeroForOne = _buyZeroForOne(key);
            BalanceDelta delta = poolManager.swap(
                key,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: int256(gpuOut), // exact-out: GPU requested
                    sqrtPriceLimitX96: _limit(zeroForOne, sqrtLimit)
                }),
                ""
            );

            uint256 gpuCredited = uint256(uint128(zeroForOne ? delta.amount1() : delta.amount0()));
            if (gpuCredited != gpuOut) revert PoolShortfall();

            // caller owes leg + hook fee in gUSD; it must fit what was funded
            int256 gusdOwed = zeroForOne ? delta.amount0() : delta.amount1(); // negative
            uint256 owed = uint256(-gusdOwed);
            if (owed > gusdAvailable) revert MaxPaidExceeded();
            uint256 change = gusdAvailable - owed;

            _managerTake(gpuToken, recipient, gpuOut);
            if (change > 0) _managerTake(address(gUSD), address(this), change);
            return abi.encode(gpuOut);
        }

        if (action == ACTION_BUY_EXACT_IN) {
            (
                ,
                PoolKey memory key,
                address gpuToken,
                uint256 gusdMaxIn,
                uint256 minGpuOut,
                uint160 sqrtLimit,
                address to
            ) = abi.decode(data, (uint8, PoolKey, address, uint256, uint256, uint160, address));

            _settleGusd();
            bool zeroForOne = _buyZeroForOne(key);
            BalanceDelta delta = poolManager.swap(
                key,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: -int256(gusdMaxIn), // exact-in; hook fees the leg
                    sqrtPriceLimitX96: _limit(zeroForOne, sqrtLimit)
                }),
                ""
            );

            uint256 gpuOut = uint256(uint128(zeroForOne ? delta.amount1() : delta.amount0()));
            if (gpuOut < minGpuOut) revert Slippage();
            // the caller's gUSD delta nets to exactly zero: settle(+maxIn) vs
            // swap(-(maxIn - fee)) minus the hook's +fee debit

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
                amountSpecified: -int256(gpuIn), // exact-in; partial fills pro-rate the fee
                sqrtPriceLimitX96: _limit(zeroForOne, sqrtLimit)
            }),
            ""
        );

        // gUSD is the currency received (positive), GPU the one spent (negative)
        int256 gusdDelta = _buyZeroForOne(key) ? delta.amount0() : delta.amount1();
        uint256 gusdNet = uint256(gusdDelta);
        if (gusdNet < requiredGusd) revert Slippage();
        _managerTake(address(gUSD), address(this), gusdNet);

        // unconsumed GPU input (partial fill) returns to the seller
        int256 gpuDelta = _buyZeroForOne(key) ? delta.amount1() : delta.amount0();
        uint256 consumed = uint256(-gpuDelta);
        if (consumed < gpuIn) _managerTake(gpuToken, seller, gpuIn - consumed);

        return abi.encode(gusdNet);
    }

    // -------------------------------------------------------------- helpers

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

    /// @dev manager.take transfers from pool reserves and debits the caller.
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
