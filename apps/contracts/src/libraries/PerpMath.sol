// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title PerpMath
/// @notice Pure math helpers for the perp engine, with the protocol's
///         rounding doctrine baked in: the vault never loses a wei. Fees and
///         debts ceil; payouts floor; entry prices round against the trader;
///         funding charges ceil, credits floor.
library PerpMath {
    using Math for uint256;

    /// @notice Basis-point denominator (1x leverage = 10_000 bps).
    uint256 internal constant BPS = 10_000;
    /// @notice gUSD per gUSD of notional (funding cumulative scale).
    uint256 internal constant FUNDING_SCALE = 1e18;
    /// @notice Parts-per-million denominator for per-second rates.
    uint256 internal constant PPM = 1_000_000;
    /// @notice Hard clamp on owner-set funding/borrow rates (ppm of notional
    ///         per second): 100_000 ppm/s = 10%/s — the anti-warehousing
    ///         bound (a rate this high clears a 10x position's margin in
    ///         seconds; owner tooling must sanity-check the scale).
    uint32 internal constant MAX_RATE_PPM_PER_SEC = 100_000;
    /// @notice Fee caps (bps): open/close/liquidation fees ≤ 10%.
    uint32 internal constant MAX_FEE_BPS = 1_000;

    /// @notice Fee on `amount`, rounded up (the ledger gains the dust).
    function feeBps(uint256 amount, uint32 bps) internal pure returns (uint256) {
        return amount.mulDiv(bps, BPS, Math.Rounding.Ceil);
    }

    /// @notice Maintenance margin for a notional, rounded up (conservative).
    function maintenance(uint256 sizeUsd, uint32 mmBps) internal pure returns (uint256) {
        return sizeUsd.mulDiv(mmBps, BPS, Math.Rounding.Ceil);
    }

    /// @notice Signed unrealized PnL (6-dec gUSD) of `sizeUsd` notional entered
    ///         at `entry`, marked at `price`. Positive payouts floor; loss
    ///         magnitudes ceil — both directions favor the vault.
    function pnl(uint256 sizeUsd, uint256 entry, bool isLong, uint256 price) internal pure returns (int256) {
        if (sizeUsd == 0 || price == entry) return 0;
        if ((isLong && price > entry) || (!isLong && price < entry)) {
            uint256 deltaUp = isLong ? price - entry : entry - price;
            return int256(sizeUsd.mulDiv(deltaUp, entry, Math.Rounding.Floor));
        }
        uint256 delta = isLong ? entry - price : price - entry;
        return -int256(sizeUsd.mulDiv(delta, entry, Math.Rounding.Ceil));
    }

    /// @notice Funding/borrow charge accrued by `sizeUsd` notional since
    ///         `checkpoint`, rounded up (the charged side pays the dust).
    function fundingOwed(uint256 sizeUsd, uint128 cum, uint128 checkpoint) internal pure returns (uint256) {
        if (cum <= checkpoint) return 0;
        return sizeUsd.mulDiv(uint256(cum - checkpoint), FUNDING_SCALE, Math.Rounding.Ceil);
    }

    /// @notice Funding credit accrued by `sizeUsd` notional since
    ///         `checkpoint`, rounded down (the credited side loses the dust).
    function fundingEarned(uint256 sizeUsd, uint128 cum, uint128 checkpoint) internal pure returns (uint256) {
        if (cum <= checkpoint) return 0;
        return sizeUsd.mulDiv(uint256(cum - checkpoint), FUNDING_SCALE, Math.Rounding.Floor);
    }

    /// @notice Skew fraction as a WAD in [0, 1e18]: |long − short| / total OI.
    ///         Zero OI is zero skew (no drift, no division by zero).
    function skewFraction(uint128 longOi, uint128 shortOi) internal pure returns (uint256) {
        uint256 totalOi = uint256(longOi) + shortOi;
        if (totalOi == 0) return 0;
        uint256 skew = longOi >= shortOi ? uint256(longOi - shortOi) : uint256(shortOi - longOi);
        return skew.mulDiv(FUNDING_SCALE, totalOi, Math.Rounding.Floor);
    }

    /// @notice Skew funding drift for one accrual window, in raw cumulative
    ///         units (WAD-scaled): `ratePpm × dt × skewFrac / 1e6`. One
    ///         mulDiv — splitting it would floor sub-ppm rates to zero.
    function fundingDrift(uint32 ratePpmPerSec, uint256 windowSec, uint256 skewFrac)
        internal
        pure
        returns (uint256)
    {
        return uint256(ratePpmPerSec).mulDiv(windowSec * skewFrac, PPM);
    }

    /// @notice Borrow-fee drift for one accrual window (both sides), in WAD
    ///         per unit notional, rounded up.
    function borrowDrift(uint32 ratePpmPerSec, uint256 windowSec) internal pure returns (uint128) {
        return uint128(uint256(ratePpmPerSec).mulDiv(windowSec * FUNDING_SCALE, PPM, Math.Rounding.Ceil));
    }

    /// @notice Pro-forma funding rate for one side (ppm of notional per
    ///         second, signed): positive = the side pays, negative = receives.
    ///         The receiving rate is capped by redistribution capacity
    ///         (payOI/recvOI of the skew) — what it would earn right now.
    function proFormaRate(uint32 ratePpmPerSec, uint128 longOi, uint128 shortOi, bool forLong)
        internal
        pure
        returns (int256)
    {
        uint256 skewFrac = skewFraction(longOi, shortOi);
        if (skewFrac == 0) return 0;
        bool longPays = longOi >= shortOi;
        int256 rate = int256(uint256(ratePpmPerSec).mulDiv(skewFrac, FUNDING_SCALE, Math.Rounding.Floor));
        if (forLong == longPays) return rate; // this side pays
        // This side receives: capped by how much the paying side holds.
        uint128 payOi = forLong ? shortOi : longOi;
        uint128 recvOi = forLong ? longOi : shortOi;
        if (recvOi == 0) return 0;
        int256 received = int256(uint256(rate).mulDiv(payOi, recvOi, Math.Rounding.Floor));
        return -received;
    }
}