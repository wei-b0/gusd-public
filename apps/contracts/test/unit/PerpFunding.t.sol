// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PerpMath} from "../../src/libraries/PerpMath.sol";
import {PerpFunding} from "../../src/libraries/PerpFunding.sol";
import {IGpuPerpEngine} from "../../src/interfaces/IGpuPerpEngine.sol";

/// @notice Funding-library math: skew drift, credit conservation, borrow fee,
///         one-sided charge, MAX_WINDOW clamp, settle deltas. The settle tests
///         run through a harness contract because storage references can only
///         point at contract state.
contract PerpFundingTest is Test {
    using Math for uint256;

    Harness internal h;

    function setUp() public {
        h = new Harness();
        h.setMarketParams(_params());
    }

    function _params() internal pure returns (IGpuPerpEngine.MarketParams memory) {
        return IGpuPerpEngine.MarketParams({
            maxLeverageBps: 200_000,
            maintenanceMarginBps: 500,
            openFeeBps: 10,
            closeFeeBps: 10,
            liquidationFeeBps: 100,
            fundingRatePpmPerSec: 5, // 5 ppm/s ≈ 43%/day at full skew
            borrowRatePpmPerSec: 1, // ≈ 8.6%/day
            maxOiUsd: 1_000_000e6,
            minCollateralUsd: 10e6,
            maxPositionUsd: 100_000e6
        });
    }

    // ----------------------------------------------------------------- drift

    function test_fundingDriftShape() public pure {
        // 5 ppm/s × 100s × skew 0.5 → 2.5e-4 WAD = 2.5e14 raw cumulative.
        assertEq(PerpMath.fundingDrift(5, 100, 0.5e18), 250_000_000_000_000);
        // Zero skew → no drift.
        assertEq(PerpMath.fundingDrift(5, 100, 0), 0);
        // Sub-ppm precision survives: 1 ppm × 1s × skew 1e-12 → 1 raw WAD unit.
        assertEq(PerpMath.fundingDrift(1, 1, 1e6), 1);
        // Below one raw unit floors to zero — never rounds up.
        assertEq(PerpMath.fundingDrift(1, 1, 1e6 - 1), 0);
    }

    function test_borrowDriftBothSides() public {
        h.setOi(50_000e6, 50_000e6); // balanced: no skew drift, borrow still accrues
        h.accrue(100);
        // 1 ppm/s × 100s = 1e-4 WAD = 1e14 raw.
        assertEq(h.borrowChargePerUnit(), 100_000_000_000_000);
        assertEq(h.fundingChargePerUnitLong(), 0);
        assertEq(h.fundingChargePerUnitShort(), 0);
    }

    function test_longsPayShortsWhenSkewed() public {
        h.setOi(75_000e6, 25_000e6); // 50k net of 100k total → skew 0.5
        h.accrue(100);
        // drift = 5ppm × 100 × 0.5 = 2.5e-4 WAD on the long charge cum.
        assertEq(h.fundingChargePerUnitLong(), 250_000_000_000_000);
        // Shorts receive pro-rata: 2.5e-4 × 75k/25k = 7.5e-4 WAD.
        assertEq(h.fundingCreditPerUnitShort(), 750_000_000_000_000);
        assertEq(h.fundingChargePerUnitShort(), 0);
        assertEq(h.fundingCreditPerUnitLong(), 0);
        assertEq(h.borrowChargePerUnit(), 100_000_000_000_000);
    }

    function test_shortsPayLongsWhenFlipped() public {
        h.setOi(25_000e6, 75_000e6);
        h.accrue(100);
        assertEq(h.fundingChargePerUnitShort(), 250_000_000_000_000);
        assertEq(h.fundingCreditPerUnitLong(), 750_000_000_000_000);
        assertEq(h.fundingChargePerUnitLong(), 0);
    }

    function test_creditRedistributesExactCharge() public {
        // Heavy skew: payers hold 10k, receivers 90k. Conservation: the
        // receiving side's total credit equals the paying side's total charge
        // (up to the pro-rata floor's dust).
        h.setOi(90_000e6, 10_000e6);
        h.accrue(100);
        uint256 charge = h.fundingChargePerUnitLong();
        uint256 credit = h.fundingCreditPerUnitShort();
        assertEq(credit, charge.mulDiv(90_000e6, 10_000e6, Math.Rounding.Floor));
        assertLe(90_000e6 * charge - 10_000e6 * credit, 10_000e6);
    }

    function test_oneSidedMarketChargesNoReceiver() public {
        h.setOi(50_000e6, 0);
        h.accrue(100);
        assertEq(h.fundingChargePerUnitLong(), 500_000_000_000_000); // full skew: 5ppm×100s = 5e-4 WAD
        assertEq(h.fundingCreditPerUnitShort(), 0); // nobody receives
    }

    function test_maxWindowClamp() public {
        h.setOi(75_000e6, 25_000e6);
        h.accrue(10_000); // idle 10k s
        // drift bounded to 3600s of accrual: 5ppm × 3600 × 0.5 = 9e-3 WAD
        assertEq(h.fundingChargePerUnitLong(), 9_000_000_000_000_000);
    }

    function test_accrueIsIdempotentAtSameTs() public {
        h.setOi(75_000e6, 25_000e6);
        h.accrue(100);
        uint128 borrow = h.borrowChargePerUnit();
        uint128 charge = h.fundingChargePerUnitLong();
        h.accrue(100); // same target timestamp → no-op
        assertEq(h.borrowChargePerUnit(), borrow);
        assertEq(h.fundingChargePerUnitLong(), charge);
    }

    // ---------------------------------------------------------------- settle

    function test_settleDeltasAndSnapshots() public {
        h.setOi(75_000e6, 25_000e6);
        h.accrue(100);
        h.setPosition(10_000e6, 1_000e6);
        // A long pays: owed = 1e10 × 2.5e-4 = 2.5 gUSD (6-dec: 2_500_000).
        PerpFunding.Settlement memory s = h.settleLong();
        assertEq(s.owed, 2_500_000);
        assertEq(s.borrow, 1_000_000); // 1e10 × 1e-4 = 1 gUSD
        assertEq(s.earned, 0);
        assertEq(s.net, -3_500_000);
        // Checkpoints snapshotted.
        assertEq(h.longFeeCheckpoint(), h.fundingChargePerUnitLong());
        assertEq(h.longBorrowCheckpoint(), h.borrowChargePerUnit());
        // Settling again is zero (nothing accrued between).
        PerpFunding.Settlement memory s2 = h.settleLong();
        assertEq(s2.owed, 0);
        assertEq(s2.borrow, 0);
    }

    function test_settleShortSideEarns() public {
        h.setOi(75_000e6, 25_000e6);
        h.accrue(100);
        h.setPosition(10_000e6, 1_000e6);
        PerpFunding.Settlement memory s = h.settleShort();
        // Short credit: 2.5e-4 × 75k/25k = 7.5e-4 → 1e10 × 7.5e-4 = 7.5 gUSD.
        assertEq(s.earned, 7_500_000);
        assertEq(s.owed, 0);
        assertEq(s.borrow, 1_000_000);
    }

    function test_chargeCeilsDust() public {
        // 1 unit of cumulative against notional 1 → sub-unit charge ceils to 1.
        h.setPosition(1, 1_000e6);
        h.forceAccumulate(1e12); // borrow cum += 1e-6 WAD
        PerpFunding.Settlement memory s = h.settleLong();
        assertEq(s.borrow, 1);
    }

    function test_creditFloorsDust() public {
        // 3 units of cumulative against notional 2 → 0.6 units credits to 0.
        h.setPosition(2, 1_000e6);
        h.forceCredit(3); // manual credit cum on the long side
        PerpFunding.Settlement memory s = h.settleLong();
        assertEq(s.earned, 0);
    }
}

/// @dev Stateful harness so the library's storage-pointer API runs against
///      real contract storage.
contract Harness {
    IGpuPerpEngine.Market public market;
    IGpuPerpEngine.Position internal pos;

    function setMarketParams(IGpuPerpEngine.MarketParams memory p) public {
        market.params = p;
        // Mirrors the engine's createMarket: the accrual clock starts now,
        // not at 0 (else the first window would include the test's start ts).
        market.fundingUpdatedAt = uint64(block.timestamp);
    }

    function setOi(uint128 longOi, uint128 shortOi) public {
        market.openNotionalLong = longOi;
        market.openNotionalShort = shortOi;
    }

    function accrue(uint64 dt) public {
        PerpFunding.accrue(market, "H100_SXM_80GB", uint64(block.timestamp) + dt);
    }

    function forceAccumulate(uint128 borrowWad) public {
        market.borrowChargePerUnit += borrowWad;
    }

    function forceCredit(uint128 creditWad) public {
        market.fundingCreditPerUnitLong += creditWad;
    }

    function setPosition(uint128 size, uint128 collateral) public {
        pos.sizeUsd = size;
        pos.collateral = collateral;
        pos.entryPrice = 2_0000;
    }

    function settleLong() public returns (PerpFunding.Settlement memory) {
        return PerpFunding.settle(market, pos, true);
    }

    function settleShort() public returns (PerpFunding.Settlement memory) {
        return PerpFunding.settle(market, pos, false);
    }

    function fundingChargePerUnitLong() public view returns (uint128) {
        return market.fundingChargePerUnitLong;
    }

    function fundingChargePerUnitShort() public view returns (uint128) {
        return market.fundingChargePerUnitShort;
    }

    function fundingCreditPerUnitLong() public view returns (uint128) {
        return market.fundingCreditPerUnitLong;
    }

    function fundingCreditPerUnitShort() public view returns (uint128) {
        return market.fundingCreditPerUnitShort;
    }

    function borrowChargePerUnit() public view returns (uint128) {
        return market.borrowChargePerUnit;
    }

    function longFeeCheckpoint() public view returns (uint128) {
        return pos.fundingFeeCheckpoint;
    }

    function longBorrowCheckpoint() public view returns (uint128) {
        return pos.borrowCheckpoint;
    }
}