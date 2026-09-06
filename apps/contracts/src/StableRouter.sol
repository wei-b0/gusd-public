// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SafeCallback} from "@uniswap/v4-periphery/base/SafeCallback.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {GUSD} from "./GUSD.sol";

/// @title StableRouter — mint/redeem gUSD funded with whitelisted stablecoins.
/// @notice GUSD mints 1:1 against its single `underlying` reserve asset. This
///         router widens the funding surface: a whitelisted stable that is NOT
///         the underlying is swapped to it on Uniswap v4 (caller-supplied
///         {stable, underlying} pool, `minOut`-bounded) before the mint; the
///         reverse applies on redemption. When the funding stable IS the
///         underlying, the router short-circuits to GUSD directly — no swap,
///         no unlock; the caller approves this router (one spender for every
///         whitelisted asset).
/// @dev    Trust is deployment-config only: `setStable` is owner-gated and the
///         frontend mirrors the whitelist from the deployment record — token
///         symbols are never an identity check (lookalike USDC/USDT tokens
///         exist on every chain). A hook-bearing pool is rejected outright:
///         the swap leg must be plain v4 so no foreign callback runs inside
///         the router's unlock. The router never holds funds at rest (`DustLeft`
///         asserted on every flow) — a fee-on-transfer stable can only DoS
///         itself, never strand protocol value. The router's own `pause()` is
///         independent of GUSD's.
contract StableRouter is SafeCallback, Pausable, ReentrancyGuard, Ownable2Step {
    // Ownable2Step's Ownable base takes the initial owner; forwarded here.
    using SafeERC20 for IERC20;

    GUSD public immutable gUSD;
    /// @notice gUSD's reserve asset; whitelisted at deploy so the identity
    ///         path always exists.
    IERC20 public immutable underlying;

    mapping(address => bool) public isStable;
    address[] internal _stables;

    uint8 private constant ACTION_MINT = 0;
    uint8 private constant ACTION_REDEEM = 1;

    error ZeroAmount();
    error UnknownStable();
    error InvalidStable();
    error BadPool();
    error Slippage();
    error DustLeft();
    error GUSDPaused();

    event StableUpdated(address indexed stable, bool allowed);
    event MintedViaSwap(address indexed stable, address indexed to, uint256 amountIn, uint256 underlyingOut, uint256 gusdOut);
    event RedeemedViaSwap(
        address indexed stable, address indexed to, uint256 gusdIn, uint256 underlyingIn, uint256 stableOut
    );

    constructor(IPoolManager poolManager_, GUSD gUSD_, address initialOwner)
        SafeCallback(poolManager_)
        Ownable(initialOwner)
    {
        gUSD = gUSD_;
        underlying = gUSD_.underlying();
        isStable[address(underlying)] = true;
        _stables.push(address(underlying));
    }

    // ---------------------------------------------------------------- owner

    /// @notice Adds or removes a funding stable. Trust comes from this list,
    ///         never from token metadata; `decimals()` must match gUSD (6) so
    ///         "1 stable-wei = 1 underlying-wei" stays honest. A token that
    ///         reverts on `decimals()` fails closed.
    function setStable(address stable, bool allowed) external onlyOwner {
        if (stable == address(0)) revert InvalidStable();
        if (stable.code.length == 0) revert InvalidStable();
        if (stable == address(gUSD)) revert InvalidStable();
        if (IERC20Metadata(stable).decimals() != gUSD.decimals()) revert InvalidStable();

        if (allowed && !isStable[stable]) {
            isStable[stable] = true;
            _stables.push(stable);
        } else if (!allowed && isStable[stable]) {
            isStable[stable] = false;
            for (uint256 i; i < _stables.length; ++i) {
                if (_stables[i] == stable) {
                    _stables[i] = _stables[_stables.length - 1];
                    _stables.pop();
                    break;
                }
            }
        }
        emit StableUpdated(stable, allowed);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Every whitelisted funding stable (the underlying included).
    function allStables() external view returns (address[] memory) {
        return _stables;
    }

    // ----------------------------------------------------------------- mint

    /// @notice Mint gUSD funded with `amountIn` of `stable` (underlying or a
    ///         whitelisted swap-in). For a non-underlying stable, `key` must be
    ///         a plain {stable, underlying} v4 pool; the swap is exact-in and
    ///         reverts when the underlying received is below `minUnderlyingOut`.
    ///         The mint fee applies to the swapped underlying — same economics
    ///         as a direct GUSD.mint. Approval note: GUSD.mint pulls from this
    ///         router, so the caller approves THIS router for the funding
    ///         stable — one spender for every whitelisted asset.
    function mint(address stable, uint256 amountIn, uint256 minUnderlyingOut, PoolKey calldata key, address to)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 gusdOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (!isStable[stable]) revert UnknownStable();
        if (gUSD.paused()) revert GUSDPaused(); // cheap fail before any swap

        if (stable == address(underlying)) {
            if (minUnderlyingOut > amountIn) revert Slippage();
            // identity path: pull, then mint straight through GUSD — no swap,
            // no unlock. GUSD pulls from the router, so the funds land here
            // first and the router grants the one-flow approval (no standing
            // allowances — the GpuRouter pattern).
            IERC20(stable).safeTransferFrom(msg.sender, address(this), amountIn);
            underlying.forceApprove(address(gUSD), amountIn);
            gusdOut = gUSD.mint(amountIn, to);
            emit MintedViaSwap(stable, to, amountIn, amountIn, gusdOut);
            return gusdOut;
        }

        _validatePool(stable, key);
        IERC20(stable).safeTransferFrom(msg.sender, address(this), amountIn);
        bytes memory ret = poolManager.unlock(abi.encode(ACTION_MINT, key, stable, amountIn, minUnderlyingOut, to));
        gusdOut = abi.decode(ret, (uint256));

        if (IERC20(stable).balanceOf(address(this)) != 0) revert DustLeft();
        if (underlying.balanceOf(address(this)) != 0) revert DustLeft();
    }

    // --------------------------------------------------------------- redeem

    /// @notice Redeem `gusdIn` gUSD for `stable` (underlying or a whitelisted
    ///         swap-out). Redeem is approval-free for the underlying path via
    ///         GUSD directly; through the router it requires a gUSD approval
    ///         (the router pulls, burns, and swaps or forwards). `minStableOut`
    ///         bounds the swap leg; the redeem fee is netted by GUSD itself.
    function redeem(address stable, uint256 gusdIn, uint256 minStableOut, PoolKey calldata key, address to)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 stableOut)
    {
        if (gusdIn == 0) revert ZeroAmount();
        if (!isStable[stable]) revert UnknownStable();
        if (gUSD.paused()) revert GUSDPaused();

        IERC20(address(gUSD)).safeTransferFrom(msg.sender, address(this), gusdIn);

        if (stable == address(underlying)) {
            stableOut = gUSD.redeem(gusdIn, to);
            if (stableOut < minStableOut) revert Slippage();
            emit RedeemedViaSwap(stable, to, gusdIn, stableOut, stableOut);
            return stableOut;
        }

        _validatePool(stable, key);
        bytes memory ret = poolManager.unlock(abi.encode(ACTION_REDEEM, key, stable, gusdIn, minStableOut, to));
        stableOut = abi.decode(ret, (uint256));

        if (IERC20(address(gUSD)).balanceOf(address(this)) != 0) revert DustLeft();
        if (underlying.balanceOf(address(this)) != 0) revert DustLeft();
        if (IERC20(stable).balanceOf(address(this)) != 0) revert DustLeft();
    }

    // ----------------------------------------------------- unlock callbacks

    function _unlockCallback(bytes calldata data) internal override returns (bytes memory) {
        uint8 action = abi.decode(data[:32], (uint8));
        if (action == ACTION_MINT) return abi.encode(_mintCallback(data));
        return abi.encode(_redeemCallback(data));
    }

    /// @dev Stable already sits on the router (pulled in mint()). Pay-then-
    ///      swap: settle the FULL balance first, swap to the underlying, take,
    ///      then mint gUSD straight to `to`.
    function _mintCallback(bytes calldata data) private returns (uint256 gusdOut) {
        (, PoolKey memory key, address stable, uint256 amountIn, uint256 minUnderlyingOut, address to) =
            abi.decode(data, (uint8, PoolKey, address, uint256, uint256, address));

        Currency s = Currency.wrap(stable);
        poolManager.sync(s);
        CurrencyLibrary.transfer(s, address(poolManager), IERC20(stable).balanceOf(address(this)));
        poolManager.settle();

        bool zeroForOne = Currency.unwrap(key.currency0) == stable;
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn), // exact-in
                sqrtPriceLimitX96: _limit(zeroForOne)
            }),
            ""
        );
        uint256 underlyingOut = uint256(uint128(zeroForOne ? delta.amount1() : delta.amount0()));
        if (underlyingOut < minUnderlyingOut) revert Slippage();
        poolManager.take(Currency.wrap(address(underlying)), address(this), underlyingOut);

        underlying.forceApprove(address(gUSD), underlyingOut);
        gusdOut = gUSD.mint(underlyingOut, to);
        emit MintedViaSwap(stable, to, amountIn, underlyingOut, gusdOut);
    }

    /// @dev The router already holds `gusdIn` gUSD (pulled in redeem()).
    ///      Redeem to the underlying, swap underlying -> stable, deliver.
    function _redeemCallback(bytes calldata data) private returns (uint256 stableOut) {
        (, PoolKey memory key, address stable, uint256 gusdIn, uint256 minStableOut, address to) =
            abi.decode(data, (uint8, PoolKey, address, uint256, uint256, address));

        uint256 underlyingIn = gUSD.redeem(gusdIn, address(this));

        Currency u = Currency.wrap(address(underlying));
        poolManager.sync(u);
        CurrencyLibrary.transfer(u, address(poolManager), underlyingIn);
        poolManager.settle();

        bool zeroForOne = Currency.unwrap(key.currency0) == address(underlying);
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(underlyingIn), // exact-in
                sqrtPriceLimitX96: _limit(zeroForOne)
            }),
            ""
        );
        stableOut = uint256(uint128(zeroForOne ? delta.amount1() : delta.amount0()));
        if (stableOut < minStableOut) revert Slippage();
        poolManager.take(Currency.wrap(stable), address(this), stableOut);
        IERC20(stable).safeTransfer(to, stableOut);
        emit RedeemedViaSwap(stable, to, gusdIn, underlyingIn, stableOut);
    }

    // -------------------------------------------------------------- helpers

    function _validatePool(address stable, PoolKey calldata key) internal view {
        if (key.hooks != IHooks(address(0))) revert BadPool();
        bool pairOk = (Currency.unwrap(key.currency0) == stable && Currency.unwrap(key.currency1) == address(underlying))
            || (Currency.unwrap(key.currency0) == address(underlying) && Currency.unwrap(key.currency1) == stable);
        if (!pairOk) revert BadPool();
    }

    /// @dev 0 = wide default on the correct side of the current price.
    function _limit(bool zeroForOne) internal pure returns (uint160) {
        return zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
    }
}
