// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IGpuPerpEngine} from "../interfaces/IGpuPerpEngine.sol";
import {PerpMath} from "./PerpMath.sol";

/// @title PerpFunding
/// @notice GMX v2-style funding for the perp engine: a skew-based funding
///         fee exchanged between long and short open interest, plus a
///         borrow fee charged to BOTH sides as vault revenue. Accrual is
///         lazy — the market's cumulatives advance at the start of every
///         executeOrder/liquidate, so an idle protocol accrues nothing and
///         no keeper transaction is ever needed. Per-position checkpoints
///         (snapshots of the cumulatives) make each position's accrued
///         amount a pure delta read.
/// @dev Conservation: during each window the paying side is charged exactly
///      what the receiving side's per-unit credit redistributes (pro-rata,
///      floor) — funding never mints or burns gUSD. Clamps only ever favor
///      the vault: a payer whose collateral cannot cover the charge simply
///      pays what it has (the receiving side's claimable is vault-backed).
library PerpFunding {
    using Math for uint256;

    /// @notice Maximum accrual window per touch (seconds). Bounds how much a
    ///         market-idle position can be charged in one settlement — the
    ///         alternative is unbounded funding debt after a long idle gap.
    uint256 internal constant MAX_WINDOW = 3600;

    /// @notice One position's settled funding amounts (6-dec gUSD).
    struct Settlement {
        uint256 owed; // skew funding this position owes
        uint256 earned; // skew funding this position earned
        uint256 borrow; // borrow fee owed (both sides)
        int256 net; // earned − owed − borrow
    }

    /// @notice Advances the market's funding cumulatives to `nowTs` and
    ///         announces the new cumulative values (indexer/keeper feed).
    function accrue(IGpuPerpEngine.Market storage m, bytes32 gpuId, uint64 nowTs) internal {
        if (nowTs <= m.fundingUpdatedAt) return;
        uint64 dt = nowTs - m.fundingUpdatedAt;
        uint256 window = dt > MAX_WINDOW ? MAX_WINDOW : dt;

        uint256 skewFrac = PerpMath.skewFraction(m.openNotionalLong, m.openNotionalShort);
        if (skewFrac > 0 && m.params.fundingRatePpmPerSec > 0) {
            uint32 rate = m.params.fundingRatePpmPerSec;
            if (rate > PerpMath.MAX_RATE_PPM_PER_SEC) rate = PerpMath.MAX_RATE_PPM_PER_SEC;
            uint256 drift = PerpMath.fundingDrift(rate, window, skewFrac);
            if (m.openNotionalLong >= m.openNotionalShort) {
                // Longs pay shorts.
                m.fundingChargePerUnitLong += uint128(drift);
                if (m.openNotionalShort > 0) {
                    m.fundingCreditPerUnitShort += uint128(
                        drift.mulDiv(m.openNotionalLong, m.openNotionalShort, Math.Rounding.Floor)
                    );
                }
            } else {
                // Shorts pay longs.
                m.fundingChargePerUnitShort += uint128(drift);
                if (m.openNotionalLong > 0) {
                    m.fundingCreditPerUnitLong += uint128(
                        drift.mulDiv(m.openNotionalShort, m.openNotionalLong, Math.Rounding.Floor)
                    );
                }
            }
        }
        if (m.params.borrowRatePpmPerSec > 0) {
            m.borrowChargePerUnit += PerpMath.borrowDrift(m.params.borrowRatePpmPerSec, window);
        }
        m.fundingUpdatedAt = nowTs;
        emit IGpuPerpEngine.FundingAccrued(
            gpuId,
            m.fundingChargePerUnitLong,
            m.fundingChargePerUnitShort,
            m.fundingCreditPerUnitLong,
            m.fundingCreditPerUnitShort,
            m.borrowChargePerUnit,
            nowTs
        );
    }

    /// @notice Settles a position's accrued funding: reads the deltas since
    ///         its checkpoints and re-snapshots them. `owed`/`borrow` are
    ///         ceil (charges), `earned` is floor (credits).
    function settle(IGpuPerpEngine.Market storage m, IGpuPerpEngine.Position storage p, bool isLong)
        internal
        returns (Settlement memory s)
    {
        uint128 feeCum = isLong ? m.fundingChargePerUnitLong : m.fundingChargePerUnitShort;
        uint128 creditCum = isLong ? m.fundingCreditPerUnitLong : m.fundingCreditPerUnitShort;
        s.owed = PerpMath.fundingOwed(p.sizeUsd, feeCum, p.fundingFeeCheckpoint);
        s.earned = PerpMath.fundingEarned(p.sizeUsd, creditCum, p.fundingCreditCheckpoint);
        s.borrow = PerpMath.fundingOwed(p.sizeUsd, m.borrowChargePerUnit, p.borrowCheckpoint);
        s.net = int256(s.earned) - int256(s.owed + s.borrow);
        p.fundingFeeCheckpoint = feeCum;
        p.fundingCreditCheckpoint = creditCum;
        p.borrowCheckpoint = m.borrowChargePerUnit;
    }
}