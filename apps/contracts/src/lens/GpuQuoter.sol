// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ParseBytes} from "@uniswap/v4-core/src/libraries/ParseBytes.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {SafeCallback} from "@uniswap/v4-periphery/base/SafeCallback.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {GPUHook} from "../hooks/GPUHook.sol";
import {GPUIssuance} from "../GPUIssuance.sol";
import {IMarketLiquidity} from "../interfaces/IMarketLiquidity.sol";

/// @title GpuQuoter — executable-quote lens for the hook market maker.
/// @notice Runs the REAL pool's REAL hook inside a PoolManager lock against a
///         private float (R11): the float is seeded into the PoolManager so
///         the hook's in-lock takes are physically backed during simulation.
///         Every quote ends in a revert — the whole unlock rolls back, so a
///         quote can never persist state. Call via eth_call (mutations
///         discarded) or accept a guaranteed-reverting transaction. Buys
///         consume the gUSD float and replenish the GPU float (and vice
///         versa) when executed as real transactions.
/// @dev    BaseV4Quoter pattern minus the strict-equality check: a
///         fully-POL-covered swap leaves the native specified delta at 0, so
///         the stock NotEnoughLiquidity check would revert on every
///         full-coverage quote. The float-seed is what breaks the naive
///         flash-quote circularity: take+re-settle nets the PM's physical
///         balance to zero, but seeding BEFORE the swap makes the hook's
///         in-lock takes real.
contract GpuQuoter is SafeCallback, Ownable2Step {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;
    using ParseBytes for bytes;
    using TransientStateLibrary for IPoolManager;

    struct QuoteResult {
        bool isBuy;
        bool exactIn;
        uint256 gusdIn; // buys: total gUSD the swapper pays (0 for sells)
        uint256 gusdOut; // sells: net gUSD the swapper receives (0 for buys)
        uint256 gpuIn; // sells: total GPU the swapper sells (0 for buys)
        uint256 gpuOut; // buys: total GPU the swapper receives (0 for sells)
        uint256 nativeGpu; // GPU filled by the native CL book
        uint256 polGpu; // GPU filled by POL inventory
        uint256 backstopGpu; // GPU minted by the issuance backstop
        uint256 polFeeGusd; // POL fee charged
        uint256 hookFeeGusd; // hook fee charged (0 for buys — taken in kind)
        uint256 issueBase; // backstop principal (buys only)
        uint256 issueFee; // backstop fee (buys only)
        int24 endTick; // pool tick after the native leg
    }

    error QuoteGpu(QuoteResult r);
    error NotSelf();
    error UnexpectedCallSuccess();
    error NotGpuPool();
    error NoFloat();
    error ZeroAmount();
    error ZeroAddress();

    GPUIssuance public immutable issuance;
    address public immutable gUSD;

    struct Snap {
        uint256 askInv; // vault ask inventory (GPU)
        uint256 principal; // vault principalContributed
        uint256 polNotional; // hook totalPolNotionalGusd
        uint256 polFees; // hook totalPolFeesGusd
        uint256 totalIssued; // issuance totalIssued
    }

    constructor(IPoolManager poolManager_, address gUSD_, GPUIssuance issuance_, address initialOwner)
        SafeCallback(poolManager_)
        Ownable(initialOwner)
    {
        if (gUSD_ == address(0) || address(issuance_) == address(0)) revert ZeroAddress();
        gUSD = gUSD_;
        issuance = issuance_;
    }

    // ---------------------------------------------------------------- floats

    /// @notice Fund the gUSD float (owner transferFrom). Buys burn float;
    ///         sell quotes replenish it only in real (non-eth_call) runs.
    function setGusdFloat(uint256 amount) external onlyOwner {
        IERC20(gUSD).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Fund a GPU float for sell quotes.
    function setGpuFloat(address gpuToken, uint256 amount) external onlyOwner {
        IERC20(gpuToken).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Owner emergency sweep of float custody (never market inventory).
    function sweep(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------- quotes

    /// @notice Quote an exactIn gUSD -> GPU buy.
    function quoteBuy(PoolKey calldata key, uint256 gusdIn) external returns (QuoteResult memory r) {
        if (gusdIn == 0) revert ZeroAmount();
        r = _run(abi.encodeCall(this._quoteBuy, (key, gusdIn)));
    }

    /// @notice Quote an exactIn GPU -> gUSD sell.
    function quoteSell(PoolKey calldata key, uint256 gpuIn) external returns (QuoteResult memory r) {
        if (gpuIn == 0) revert ZeroAmount();
        r = _run(abi.encodeCall(this._quoteSell, (key, gpuIn)));
    }

    /// @notice Quote an exactOut GPU buy (demand GPU, pay gUSD at ask).
    function quoteBuyExactOut(PoolKey calldata key, uint256 gpuDemand) external returns (QuoteResult memory r) {
        if (gpuDemand == 0) revert ZeroAmount();
        r = _run(abi.encodeCall(this._quoteBuyExactOut, (key, gpuDemand)));
    }

    /// @notice Quote an exactOut gUSD sell (demand gUSD, pay GPU at bid).
    function quoteSellExactOut(PoolKey calldata key, uint256 gusdDemand) external returns (QuoteResult memory r) {
        if (gusdDemand == 0) revert ZeroAmount();
        r = _run(abi.encodeCall(this._quoteSellExactOut, (key, gusdDemand)));
    }

    function _run(bytes memory data) internal returns (QuoteResult memory) {
        bytes memory reason;
        try poolManager.unlock(data) {}
        catch (bytes memory reason_) {
            reason = reason_;
        }
        return _parse(reason);
    }

    /// @dev Unwraps QuoteGpu(QuoteResult); any other error bubbles verbatim —
    ///      a failed quote is never a number.
    function _parse(bytes memory reason) internal view returns (QuoteResult memory r) {
        if (reason.parseSelector() != QuoteGpu.selector) {
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
        // reason = QuoteGpu.selector ++ abi.encode(QuoteResult)
        uint256 len = reason.length - 4;
        bytes memory payload = new bytes(len);
        assembly ("memory-safe") {
            let ok := staticcall(gas(), 4, add(reason, 0x24), len, add(payload, 0x20), len)
            if iszero(ok) {
                revert(0, 0)
            }
        }
        return abi.decode(payload, (QuoteResult));
    }

    modifier selfOnly() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    /// @dev Mirrors BaseV4Quoter — run the inner simulation, bubble its
    ///      revert (QuoteGpu or the real error) up to unlock. The inner
    ///      revert plus this bubble reverts the entire call, so no quote can
    ///      ever persist state.
    function _unlockCallback(bytes calldata data) internal override returns (bytes memory) {
        (bool success, bytes memory returnData) = address(this).call(data);
        if (success) revert UnexpectedCallSuccess();
        assembly ("memory-safe") {
            revert(add(returnData, 0x20), mload(returnData))
        }
    }

    // ------------------------------------------------------------ simulation

    function _quoteBuy(PoolKey calldata key, uint256 gusdIn) external selfOnly {
        (bool gIsC0, bytes32 gpuId, Currency gpuCur) = _ctx(key);
        GPUHook hook = GPUHook(address(key.hooks));
        Snap memory s0 = _snap(hook, gpuId);
        _seed(Currency.wrap(gUSD), gUSD);
        _swap(key, gIsC0, -int256(gusdIn));
        QuoteResult memory r = _finish(hook, gpuId, s0, true, true);
        r.gusdIn = gusdIn;
        int256 dGpu = poolManager.currencyDelta(address(this), gpuCur);
        r.gpuOut = dGpu > 0 ? uint256(dGpu) : 0;
        // the hook takes its exactIn-buy fee IN KIND off the delivered fills
        // (GPUHook._settleBuyIn: ceil(fill x hookFeeBps / 1e4)), so the
        // caller's GPU credit is fills - fee; add the fee back or the native
        // decomposition underflows whenever the fill exceeds the native leg
        // add BEFORE subtracting: gpuOut + fee >= fills always (native >= 0),
        // whereas gpuOut - fills alone can go negative on in-kind-fee buys
        r.nativeGpu = r.gpuOut + Math.mulDiv(r.polGpu + r.backstopGpu, hook.hookFeeBps(), 1e4, Math.Rounding.Ceil)
            - r.polGpu - r.backstopGpu;
        r.endTick = _tick(key);
        revert QuoteGpu(r);
    }

    function _quoteSell(PoolKey calldata key, uint256 gpuIn) external selfOnly {
        (bool gIsC0, bytes32 gpuId, Currency gpuCur) = _ctx(key);
        GPUHook hook = GPUHook(address(key.hooks));
        Snap memory s0 = _snap(hook, gpuId);
        _seed(gpuCur, Currency.unwrap(gpuCur));
        _swap(key, !gIsC0, -int256(gpuIn));
        QuoteResult memory r = _finish(hook, gpuId, s0, false, true);
        r.gpuIn = gpuIn;
        int256 dGusd = poolManager.currencyDelta(address(this), Currency.wrap(gUSD));
        r.gusdOut = dGusd > 0 ? uint256(dGusd) : 0;
        r.nativeGpu = r.gpuIn - r.polGpu;
        r.endTick = _tick(key);
        revert QuoteGpu(r);
    }

    function _quoteBuyExactOut(PoolKey calldata key, uint256 gpuDemand) external selfOnly {
        (bool gIsC0, bytes32 gpuId,) = _ctx(key);
        GPUHook hook = GPUHook(address(key.hooks));
        Snap memory s0 = _snap(hook, gpuId);
        uint256 float = _seed(Currency.wrap(gUSD), gUSD);
        _swap(key, gIsC0, int256(gpuDemand));
        QuoteResult memory r = _finish(hook, gpuId, s0, true, false);
        r.gpuOut = gpuDemand;
        r.nativeGpu = gpuDemand - r.polGpu - r.backstopGpu;
        int256 dGusd = poolManager.currencyDelta(address(this), Currency.wrap(gUSD));
        // caller credit = seed - total spend (must be >= 0 or unlock reverted)
        r.gusdIn = float - uint256(dGusd);
        r.endTick = _tick(key);
        revert QuoteGpu(r);
    }

    function _quoteSellExactOut(PoolKey calldata key, uint256 gusdDemand) external selfOnly {
        (bool gIsC0, bytes32 gpuId, Currency gpuCur) = _ctx(key);
        GPUHook hook = GPUHook(address(key.hooks));
        Snap memory s0 = _snap(hook, gpuId);
        uint256 float = _seed(gpuCur, Currency.unwrap(gpuCur));
        _swap(key, !gIsC0, int256(gusdDemand));
        QuoteResult memory r = _finish(hook, gpuId, s0, false, false);
        r.gusdOut = gusdDemand;
        int256 dGpu = poolManager.currencyDelta(address(this), gpuCur);
        r.gpuIn = float - uint256(dGpu);
        r.nativeGpu = r.gpuIn - r.polGpu;
        r.endTick = _tick(key);
        revert QuoteGpu(r);
    }

    // --------------------------------------------------------------- helpers

    /// @dev Pool orientation + registration: gpuId from the hook's registry,
    ///      gIsC0 decides the buy/sell swap direction.
    function _ctx(PoolKey calldata key) internal view returns (bool gIsC0, bytes32 gpuId, Currency gpuCur) {
        GPUHook hook = GPUHook(address(key.hooks));
        gpuId = hook.poolGpuId(key.toId());
        if (gpuId == bytes32(0)) revert NotGpuPool();
        gIsC0 = Currency.unwrap(key.currency0) == gUSD;
        gpuCur = gIsC0 ? key.currency1 : key.currency0;
    }

    /// @dev Accounting snapshot taken around the simulated swap; every fill
    ///      source books a counter, so deltas decompose the fill exactly.
    function _snap(GPUHook hook, bytes32 gpuId) internal view returns (Snap memory s) {
        IMarketLiquidity vault = IMarketLiquidity(issuance.marketLiquidity());
        s.askInv = vault.askInventoryGpu(gpuId);
        s.principal = vault.principalContributed(gpuId);
        s.polNotional = hook.totalPolNotionalGusd();
        s.polFees = hook.totalPolFeesGusd();
        s.totalIssued = issuance.gpuConfig(gpuId).totalIssued;
    }

    /// @dev Seed the float into the PoolManager: sync -> transfer -> settle
    ///      gives this contract ledger credit the swap (and the hook's
    ///      in-lock takes) can spend. Returns the seeded amount.
    function _seed(Currency c, address token) internal returns (uint256 floatAmount) {
        floatAmount = IERC20(token).balanceOf(address(this));
        if (floatAmount == 0) revert NoFloat();
        poolManager.sync(c);
        IERC20(token).safeTransfer(address(poolManager), floatAmount);
        poolManager.settle();
    }

    function _swap(PoolKey calldata key, bool zeroForOne, int256 amountSpecified) internal returns (BalanceDelta) {
        return poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
    }

    function _tick(PoolKey calldata key) internal view returns (int24) {
        (, int24 tick,,) = StateLibrary.getSlot0(poolManager, key.toId());
        return tick;
    }

    /// @dev Counter deltas -> fill decomposition. Buys deplete ask inventory
    ///      (POL GPU) and mint via the backstop; sells add to ask inventory
    ///      and debit bid inventory. hookFee reproduces the hook's own
    ///      rounding for the shapes that charge it in gUSD.
    function _finish(GPUHook hook, bytes32 gpuId, Snap memory s0, bool isBuy, bool exactIn)
        internal
        view
        returns (QuoteResult memory r)
    {
        Snap memory s1 = _snap(hook, gpuId);
        r.isBuy = isBuy;
        r.exactIn = exactIn;
        r.polGpu = isBuy ? s0.askInv - s1.askInv : s1.askInv - s0.askInv;
        r.polFeeGusd = s1.polFees - s0.polFees;
        r.issueBase = s1.principal - s0.principal;
        r.issueFee = Math.mulDiv(r.issueBase, issuance.feeBpsOf(gpuId), 1e4, Math.Rounding.Ceil);
        r.backstopGpu = s1.totalIssued - s0.totalIssued;
        uint256 polSpend = s1.polNotional - s0.polNotional;
        uint256 feeBps = hook.hookFeeBps();
        if (isBuy && !exactIn) {
            uint256 charge = polSpend + r.issueBase + r.issueFee;
            r.hookFeeGusd = Math.mulDiv(charge, feeBps, 1e4, Math.Rounding.Ceil);
        } else if (!isBuy) {
            uint256 net = polSpend - r.polFeeGusd;
            r.hookFeeGusd = Math.mulDiv(net, feeBps, 1e4, Math.Rounding.Ceil);
        }
    }
}
