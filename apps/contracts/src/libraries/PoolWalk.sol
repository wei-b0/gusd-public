// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapMath} from "@uniswap/v4-core/src/libraries/SwapMath.sol";
import {BitMath} from "@uniswap/v4-core/src/libraries/BitMath.sol";
import {LiquidityMath} from "@uniswap/v4-core/src/libraries/LiquidityMath.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title PoolWalk — permissionless bounded simulation of a v4 pool's book.
/// @notice The GPUHook's edge-walk machinery, extracted so the hook's runtime
///         bytecode stays under EIP-170's 24576-byte create limit. Stateless:
///         every function reads live PoolManager state and touches nothing,
///         so the hook can hold one instance immutably and call it freely
///         inside swaps. Reads are the permissionless StateLibrary set
///         (slot0, liquidity, tick info, bitmap) — same trust as v4's own
///         ReservesLens probing.
contract PoolWalk {
    uint256 internal constant PROBE_WORDS = 8;

    /// @dev Edge sqrt price at price*(1±bps/1e4) for the pool's orientation.
    ///      gIsC0 pools invert (sqrtP = 2^192/refSqrt); others go direct.
    function edgeSqrt(uint256 price, uint16 bps, bool gIsC0, bool isAsk, uint256 cd) public pure returns (uint160) {
        uint256 scaledBps = isAsk ? 10_000 + uint256(bps) : 10_000 - uint256(bps);
        uint256 factor = FixedPointMathLib.sqrt(scaledBps * 1e14);
        uint256 refSqrt = FixedPointMathLib.sqrt(Math.mulDiv(price, 1 << 192, cd));
        uint256 edge;
        if (gIsC0) {
            // denom = refSqrt*factor/1e9 normalizes factor (=sqrt(bps*1e14));
            // the reciprocal pool price is exactly 2^192/denom — no extra 1e9.
            edge = Math.mulDiv(1 << 192, 1, Math.mulDiv(refSqrt, factor, 1e9));
        } else {
            edge = Math.mulDiv(refSqrt, factor, 1e9);
        }
        if (edge > type(uint160).max) revert OraclePriceRange();
        return uint160(edge);
    }

    /// @dev Bounded simulation of Pool.swap's walk from spot to `edge`,
    ///      word-skipping the bitmap (initialized ticks only). byOutput
    ///      switches the consumption budget between input (exactIn shapes)
    ///      and output (exactOut shapes). Returns the native input/output
    ///      consumed to reach the edge (w), whether the edge was reached
    ///      (hitEdge), and whether the cap fired (capped). Mirrors
    ///      Pool.swap's loop: crossing flips liquidityNet by direction and
    ///      ticks move exactly as native execution would.
    function walk(
        IPoolManager manager,
        PoolId poolId,
        int24 tickSpacing,
        bool zeroForOne,
        uint160 edge,
        uint256 budget,
        bool byOutput,
        uint24 swapFee,
        uint256 maxWalkTicks
    ) external view returns (uint256 w, bool hitEdge, bool capped) {
        (uint160 sqrtP, int24 tick,,) = StateLibrary.getSlot0(manager, poolId);
        uint128 liq = StateLibrary.getLiquidity(manager, poolId);
        uint160 stepSqrt = sqrtP;
        int24 t = tick;
        uint256 remaining = budget;
        uint256 i = 0;
        while (i < maxWalkTicks) {
            if (zeroForOne ? stepSqrt <= edge : stepSqrt >= edge) {
                hitEdge = true;
                break;
            }
            (int24 tickNext, bool initialized) = _nextTick(manager, poolId, tickSpacing, t, zeroForOne);
            // MIN/MAX clamp exactly as Pool.swap does.
            if (tickNext < TickMath.MIN_TICK) {
                tickNext = TickMath.MIN_TICK;
            } else if (tickNext > TickMath.MAX_TICK) {
                tickNext = TickMath.MAX_TICK;
            }
            uint160 sqrtNext = TickMath.getSqrtPriceAtTick(tickNext);
            // Target = the nearer of the next tick and the edge (Pool.swap's
            // getSqrtPriceTarget for this direction).
            uint160 target = zeroForOne
                ? uint160(Math.max(uint256(sqrtNext), uint256(edge)))
                : uint160(Math.min(uint256(sqrtNext), uint256(edge)));
            (uint160 sqrtNextStep, uint256 amountIn, uint256 amountOut, uint256 feeAmount) = SwapMath.computeSwapStep(
                stepSqrt, target, liq, byOutput ? int256(remaining) : -int256(remaining), swapFee
            );
            uint256 consumed = byOutput ? amountOut : (amountIn + feeAmount);
            w += consumed;
            remaining -= Math.min(remaining, consumed);
            ++i;
            if (sqrtNextStep == target) {
                if (target == edge) {
                    hitEdge = true;
                    break;
                }
                // Cross the tick exactly as Pool.swap does.
                if (initialized) {
                    (, int128 liquidityNet,,) = StateLibrary.getTickInfo(manager, poolId, tickNext);
                    if (zeroForOne) {
                        if (liquidityNet < 0) liq = LiquidityMath.addDelta(liq, -liquidityNet);
                    } else {
                        if (liquidityNet > 0) liq = LiquidityMath.addDelta(liq, liquidityNet);
                    }
                    t = zeroForOne ? tickNext - 1 : tickNext;
                } else {
                    t = tickNext;
                }
                stepSqrt = sqrtNextStep;
            } else {
                // Budget exhausted mid-range: native fills everything.
                break;
            }
        }
        if (!hitEdge && i >= maxWalkTicks) capped = true;
    }

    /// @dev Mirror of TickBitmap.nextInitializedTickWithinOneWord against
    ///      manager state (StateLibrary + BitMath): the next initialized tick
    ///      within the current word, or the word boundary (word-skipping).
    function _nextTick(IPoolManager manager, PoolId poolId, int24 tickSpacing, int24 tick, bool lte)
        internal
        view
        returns (int24 next, bool initialized)
    {
        int24 compressed = tick / tickSpacing;
        if (tick < 0 && tick % tickSpacing != 0) --compressed;
        (int16 wordPos, uint8 posInWord) = (int16(compressed >> 8), uint8(uint24(compressed & 0xff)));
        uint256 word = StateLibrary.getTickBitmap(manager, poolId, wordPos);
        if (lte) {
            uint256 mask = type(uint256).max >> (255 - posInWord);
            uint256 masked = word & mask;
            initialized = masked != 0;
            next = initialized
                ? (compressed - int24(uint24(posInWord - BitMath.mostSignificantBit(masked)))) * tickSpacing
                : (compressed - int24(uint24(posInWord))) * tickSpacing;
        } else {
            unchecked {
                ++compressed;
            }
            (wordPos, posInWord) = (int16(compressed >> 8), uint8(uint24(compressed & 0xff)));
            word = StateLibrary.getTickBitmap(manager, poolId, wordPos);
            uint256 mask = ~((1 << posInWord) - 1);
            uint256 masked = word & mask;
            initialized = masked != 0;
            next = initialized
                ? (compressed + int24(uint24(BitMath.leastSignificantBit(masked) - posInWord))) * tickSpacing
                : (compressed + int24(uint24(255 - posInWord))) * tickSpacing;
        }
    }

    /// @dev Conservative bitmap probe for LP liquidity beyond the edge in the
    ///      walk direction: scans up to PROBE_WORDS words; the first word is
    ///      masked to the correct side of the start tick. A found tick means
    ///      a native residual executes honestly past the edge.
    function lpsBeyondEdge(
        IPoolManager manager,
        PoolId poolId,
        int24 tickSpacing,
        bool zeroForOne,
        uint256 price,
        uint16 bps,
        bool gIsC0,
        uint256 cd
    ) external view returns (bool) {
        bool isAsk = zeroForOne == gIsC0;
        uint160 edge = edgeSqrt(price, bps, gIsC0, isAsk, cd);
        int24 edgeTick = TickMath.getTickAtSqrtPrice(edge);
        int24 startTick = zeroForOne ? edgeTick - 1 : edgeTick + 1;
        if (startTick < TickMath.MIN_TICK || startTick > TickMath.MAX_TICK) return false;
        int24 compressed = startTick / tickSpacing;
        if (startTick < 0 && startTick % tickSpacing != 0) --compressed;
        int16 wordPos = int16(compressed >> 8);
        uint8 posInWord = uint8(uint24(compressed & 0xff));
        int16 dir = zeroForOne ? int16(-1) : int16(1);
        for (uint256 k = 0; k < PROBE_WORDS; ++k) {
            uint256 word = StateLibrary.getTickBitmap(manager, poolId, wordPos);
            uint256 relevant;
            if (zeroForOne) {
                relevant = k == 0 ? word & (type(uint256).max >> (255 - posInWord)) : word;
            } else {
                relevant = k == 0 ? word >> posInWord : word;
            }
            if (relevant != 0) return true;
            wordPos += dir;
        }
        return false;
    }

    error OraclePriceRange();
}
