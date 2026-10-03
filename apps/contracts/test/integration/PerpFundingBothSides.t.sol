// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {OracleReports} from "../utils/OracleReports.sol";
import {GUSD} from "../../src/GUSD.sol";
import {sgUSD} from "../../src/sgUSD.sol";
import {RevenueLedger} from "../../src/RevenueLedger.sol";
import {GpuPerpEngine} from "../../src/GpuPerpEngine.sol";
import {IGpuPerpEngine} from "../../src/interfaces/IGpuPerpEngine.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PerpBase} from "./PerpLifecycle.t.sol";

using Math for uint256;

/// @notice Funding through the engine. Each `_nextEpoch()` step is exactly
///         60s, so accrual windows are exact. Rates: funding 5_000 ppm/s
///         (0.5%/s), borrow 1_000 ppm/s (0.1%/s) — hot for readable numbers.
contract PerpFundingBothSidesTest is PerpBase {
    function setUp() public {
        _deployOracle();
        underlying = new MockERC20("USD Coin", "USDC", 6);
        gusd = new GUSD(IERC20(address(underlying)), address(this));
        sg = new sgUSD(IERC20(address(gusd)), address(this));
        ledger = new RevenueLedger(IERC20(address(gusd)), address(this));
        engine = new GpuPerpEngine(IERC20(address(gusd)), sg, oracle, address(ledger), address(this));
        sg.setPerpEngine(address(engine));
        sg.setEngineMaxWithdrawPerBlock(type(uint256).max);
        _mintGusd(address(this), 2_000_000e6);
        gusd.approve(address(sg), type(uint256).max);
        sg.seed(1_000_000e6);
        _mintGusd(alice, 100_000e6);
        _mintGusd(bob, 100_000e6);

        IGpuPerpEngine.MarketParams memory p = _defaultParams();
        p.fundingRatePpmPerSec = 100; // 0.01%/s ≈ 8.6%/day at full skew
        p.borrowRatePpmPerSec = 10; // 0.001%/s both sides
        engine.createMarket(H100, p);
    }

    function _mintGusd(address to, uint256 amt) internal {
        underlying.mint(to, amt);
        vm.startPrank(to);
        underlying.approve(address(gusd), type(uint256).max);
        gusd.mint(amt, to);
        vm.stopPrank();
    }

    /// One-sided OI: the long pays the full skew rate with no receiver — the
    /// charge drains collateral at the next touch and the borrow fee accrues
    /// alongside. A 60s window: skew drift 0.006 WAD (6 gUSD on 10k), borrow
    /// drift 0.0006 WAD (0.6 gUSD).
    function test_oneSidedChargeDrainsCollateral() public {
        _createAndExecute(
            alice, _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 10_000e6, 1_000e6, 2_0000, 0), 2_0000
        );
        // Touch via a small top-up exactly 60s later (one epoch).
        vm.startPrank(alice);
        gusd.approve(address(engine), type(uint256).max);
        uint256 topUp = engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 1_000e6, 1_000e6, 2_0000, 0)
        );
        vm.stopPrank();
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(topUp, _updateData(H100, 2_0000));

        // Charged at the touch: old size 1e10 × (0.006 + 0.0006) WAD = 66e6.
        // New collateral = 990_000_000 − 66e6 + 1_000e6 − openFee(1e6).
        IGpuPerpEngine.Position memory pos = engine.positions(alice, H100, true);
        assertEq(pos.collateral, 990_000_000 - 66_000_000 + 1_000e6 - 1_000_000);
        assertEq(pos.sizeUsd, 11_000e6);
        // No receivers existed: nobody's claimable grew.
        assertEq(engine.claimableOf(bob), 0);
        // Pro-forma rates: full skew → long pays 0.5%/s, short side idle.
        IGpuPerpEngine.MarketView memory mv = engine.getMarket(H100);
        assertEq(mv.fundingRateLongPpmPerSec, 100);
        assertEq(mv.fundingRateShortPpmPerSec, 0);
        assertEq(mv.borrowRatePpmPerSec, 10);
    }

    /// Both sides: the LARGER OI side pays, the minority receives pro-rata
    /// (GMX v2 — funding pushes OI back toward balance), one WAD-window at a
    /// time, conserved to the floor.
    function test_fundingRedistributesAndConserves() public {
        // t0: alice longs 10k (only OI).
        _createAndExecute(
            alice, _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 10_000e6, 5_000e6, 2_0000, 0), 2_0000
        );
        // t0+60: bob shorts 40k. Window A→B (one-sided long, 60s): the only
        // side is the paying side — long charge cum += 0.006 WAD = 6e15;
        // borrow cum += 0.0006 WAD = 6e14.
        _createAndExecute(
            bob, _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, false, 40_000e6, 20_000e6, 2_0000, 0), 2_0000
        );
        assertEq(engine.markets(H100).fundingChargePerUnitLong, 6_000_000_000_000_000);
        assertEq(engine.markets(H100).fundingChargePerUnitShort, 0);
        // Borrow cum: the 20s createMarket→first-open window (2e14, no OI
        // yet) plus this 60s window (6e14) — it accrues from contract birth.
        assertEq(engine.markets(H100).borrowChargePerUnit, 800_000_000_000_000);

        // t0+120: alice closes. Window B→C (OI 10k/40k, 60s): shorts are the
        // larger side and pay — short charge cum += 0.0036 WAD = 3.6e15;
        // longs receive pro-rata: 4e10 payers over 1e10 receivers → credit
        // per long unit = 4× the drift = 1.44e16 WAD. Borrow cum += 6e14.
        vm.startPrank(alice);
        gusd.approve(address(engine), type(uint256).max);
        uint256 close = engine.createOrder(_order(H100, IGpuPerpEngine.OrderKind.MarketDecrease, true, 0, 0, 2_0000, 0));
        vm.stopPrank();
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(close, _updateData(H100, 2_0000));
        assertEq(engine.markets(H100).fundingChargePerUnitShort, 3_600_000_000_000_000);
        assertEq(engine.markets(H100).fundingCreditPerUnitLong, 14_400_000_000_000_000);

        // Alice settles her full life (checkpoints at open): owed = 1e10 ×
        // 6e15/1e18 = 60 gUSD (the one-sided window — she was the only
        // side), earned = 1e10 × 1.44e16/1e18 = 144 gUSD (bob's side paid
        // her), borrow = 1e10 × (1.4e15 − 2e14)/1e18 = 12 gUSD (her
        // open→close window only), against collateral 4_990_000_000 (open
        // fee already taken) — no clamp.
        // due = 4_990e6 − 10e6 (close fee) − 60e6 + 144e6 − 12e6.
        assertEq(engine.claimableOf(alice), 5_052_000_000);
        assertEq(engine.claimableOf(bob), 0); // bob hasn't been touched yet

        // Bob closes at the same price. Window C→D (one-sided short, 60s):
        // shorts pay with no receiver — short charge cum += 6e15; borrow cum
        // += 6e14. Bob owes funding 4e10 × (3.6e15 + 6e15)/1e18 = 384 gUSD
        // and borrow 4e10 × (2e15 − 8e14)/1e18 = 48 gUSD; his pnl = 0.
        vm.startPrank(bob);
        gusd.approve(address(engine), type(uint256).max);
        uint256 bobClose = engine.createOrder(_order(H100, IGpuPerpEngine.OrderKind.MarketDecrease, false, 0, 0, 2_0000, 0));
        vm.stopPrank();
        _nextEpoch();
        vm.prank(alice);
        engine.executeOrder(bobClose, _updateData(H100, 2_0000));
        // due = released 19_960_000_000 − closeFee 40_000_000 − 384e6 − 48e6
        assertEq(engine.claimableOf(bob), 19_488_000_000);
        // Conservation inside the B→C window: shorts paid 4e10 × 3.6e15/1e18
        // = 144 gUSD; longs were credited 1e10 × 1.44e16/1e18 = 144 gUSD. ✓
        _assertEngineBalance(0);
    }

    function test_idleGapChargesAtMostMaxWindow() public {
        _createAndExecute(
            alice, _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 10_000e6, 1_000e6, 2_0000, 0), 2_0000
        );
        // One-sided OI; idle a year. The charge caps at 3600s of accrual.
        vm.warp(block.timestamp + 365 days);
        vm.startPrank(alice);
        gusd.approve(address(engine), type(uint256).max);
        uint256 close = engine.createOrder(_order(H100, IGpuPerpEngine.OrderKind.MarketDecrease, true, 0, 0, 2_0000, 0));
        vm.stopPrank();
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(close, _updateData(H100, 2_0000));
        // Capped charge: 0.01%/s × 3600s × 1.0 skew = 0.36 WAD → 3_600 gUSD on
        // 10k notional; borrow 0.001%/s × 3600s = 0.036 WAD → 360 gUSD. That
        // dwarfs the 990 gUSD collateral: the charge clamps at everything the
        // position holds and nothing is claimable.
        assertEq(engine.claimableOf(alice), 0);
        IGpuPerpEngine.Market memory m = engine.markets(H100);
        assertEq(uint256(m.fundingChargePerUnitLong), 100 * 3600 * 1e12); // 0.36 WAD
        // Borrow cum: the pre-open 20s window (2e14) + the capped year window.
        assertEq(uint256(m.borrowChargePerUnit), 10 * 3600 * 1e12 + 2e14); // 0.0362 WAD
        // The year's unfunded excess is forgiven, not carried forward.
        vm.warp(block.timestamp + 60);
        IGpuPerpEngine.PositionView memory v = engine.getPosition(alice, H100, true, _updateData(H100, 2_0000));
        // position is closed; probe of a fresh position is zeroed — the gap
        // does not resurrect. (Direct evidence: settle a second open.)
        assertEq(v.position.sizeUsd, 0);
    }

    /// A rate change must never apply retroactively to the un-accrued window:
    /// setMarketParams accrues under the OLD rate first (G3), so the hot new
    /// rate starts from the touch, not from the last accrual.
    function test_paramChangeAccruesFirst() public {
        // alice longs 10k — one-sided, the long pays full skew.
        _createAndExecute(
            alice, _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 10_000e6, 5_000e6, 2_0000, 0), 2_0000
        );
        // Idle 120s, then the owner turns the rate up to 2%/s.
        vm.warp(vm.getBlockTimestamp() + 120);
        IGpuPerpEngine.MarketParams memory p = _defaultParams();
        p.fundingRatePpmPerSec = 20_000;
        p.borrowRatePpmPerSec = 10;
        engine.setMarketParams(H100, p);
        // The idle window settled at the OLD rate before the change: 100 ppm/s
        // × 120s × full skew = 1.2e16 WAD — not a single unit at 2%/s.
        assertEq(engine.markets(H100).fundingChargePerUnitLong, 12_000_000_000_000_000);
        // The accrual consumed the idle gap: the new rate starts from now.
        assertEq(engine.markets(H100).fundingUpdatedAt, vm.getBlockTimestamp());
        // The next touch (one epoch later) accrues at the NEW rate:
        // 20_000×60/1e6 = 1.2e18 WAD.
        _createAndExecute(
            bob, _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 10_000e6, 5_000e6, 2_0000, 0), 2_0000
        );
        assertEq(
            engine.markets(H100).fundingChargePerUnitLong,
            12_000_000_000_000_000 + 1_200_000_000_000_000_000
        );
    }

    /// @dev alice longs 10k @ 2.0 (2x, coll 5k); +60s bob shorts 40k @ 2.0.
    ///      Alice's checkpoints pin at her open (long charge 0, credit 0,
    ///      borrow 2e14 — the pre-open 20s window). By her close one epoch
    ///      later the long charge is 6e15 (60s one-sided), the long credit
    ///      1.44e16 (bob's side paid), borrow 1.4e15 — the same window
    ///      arithmetic as test_fundingRedistributesAndConserves.
    function _openSkew() internal {
        _createAndExecute(
            alice, _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 10_000e6, 5_000e6, 2_0000, 0), 2_0000
        );
        _createAndExecute(
            bob, _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, false, 40_000e6, 20_000e6, 2_0000, 0), 2_0000
        );
    }

    /// Partial close (G2): the closed HALF settles only ITS share of the
    /// accrued funding — owed 30e6 (of 60e6), borrow 6e6 (of 12e6), earned
    /// 72e6 (of 144e6) — never the whole position's funding in one tranche.
    function test_partialCloseAttributionProRata() public {
        _openSkew();
        vm.startPrank(alice);
        gusd.approve(address(engine), type(uint256).max);
        uint256 close =
            engine.createOrder(_order(H100, IGpuPerpEngine.OrderKind.MarketDecrease, true, 5_000e6, 0, 2_0000, 0));
        vm.stopPrank();
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(close, _updateData(H100, 2_0000));
        // due = released 2_495e6 − closeFee 5e6 − 30e6 − 6e6 + 72e6.
        assertEq(engine.claimableOf(alice), 2_526_000_000);
        assertEq(engine.claimableOf(bob), 0);
        // The remainder's unattributed DEBT rewinds into its checkpoints
        // (back at the cumulatives of her open); its earned share stays in
        // the balance — the floor slice 72e6 joined the close `due`, the
        // other half is carried, and the credit checkpoint merely re-snapped
        // to the market cumulative (no credit rewind exists anymore).
        IGpuPerpEngine.Position memory pos = engine.positions(alice, H100, true);
        assertEq(pos.sizeUsd, 5_000e6);
        assertEq(pos.collateral, 2_495_000_000);
        assertEq(pos.fundingFeeCheckpoint, 0);
        assertEq(pos.borrowCheckpoint, 200_000_000_000_000);
        assertEq(pos.earnedFunding, 72_000_000);
        assertEq(pos.fundingCreditCheckpoint, 14_400_000_000_000_000);
        assertEq(engine.totalEarnedFunding(), 72_000_000);
        // Engine at rest: alice's remainder + bob's escrowed collateral
        // (20_000e6 − 0.1% open fee).
        _assertEngineBalance(2_495_000_000 + 19_960_000_000);
    }

    /// The carried remainder pays its debt at the NEXT touch: the second
    /// half's settlement includes the 30e6 funding the first half left
    /// behind (pre-G2 it was forgiven at the first close), plus its own
    /// window's borrow and credit.
    function test_partialCloseCarriesRemainderDebt() public {
        _openSkew();
        vm.startPrank(alice);
        gusd.approve(address(engine), type(uint256).max);
        uint256 close =
            engine.createOrder(_order(H100, IGpuPerpEngine.OrderKind.MarketDecrease, true, 5_000e6, 0, 2_0000, 0));
        vm.stopPrank();
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(close, _updateData(H100, 2_0000));
        assertEq(engine.claimableOf(alice), 2_526_000_000);

        // One more epoch (shorts still dominate: skew 35k/45k → drift
        // 4_666_666_666_666_666 WAD, credit per long unit 8× = 37_333_333_…
        // → credit cum 51_733_333_333_333_328; borrow cum 2e15), then close
        // the rest. The remainder settles its carried 30e6 of first-window
        // funding, its own 9e6 borrow, and 258_666_666 of credits.
        vm.startPrank(alice);
        uint256 close2 = engine.createOrder(_order(H100, IGpuPerpEngine.OrderKind.MarketDecrease, true, 0, 0, 2_0000, 0));
        vm.stopPrank();
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(close2, _updateData(H100, 2_0000));
        // due2 = 2_495e6 − 5e6 − 30e6 − 9e6 + 258_666_666 = 2_709_666_666.
        assertEq(engine.claimableOf(alice), 2_526_000_000 + 2_709_666_666);
        assertEq(engine.positions(alice, H100, true).sizeUsd, 0);
    }

    /// The touch-time credit lands in the POSITION, not the counter: the
    /// balance grows by the settlement's earned, `claimableOf` stays at
    /// zero, the accumulator grows with it, and the vault is swept exactly
    /// the charged side — the credit is accounting, not gUSD moving.
    function test_increaseTouchAccruesIntoBalance() public {
        _openSkew();
        // One more epoch: OI 10k/40k — shorts dominate and pay; the long
        // credit index climbs 3.6e15 × 4 = 1.44e16 WAD over the window.
        vm.startPrank(alice);
        gusd.approve(address(engine), type(uint256).max);
        uint256 topUp = engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 10_000e6, 1_000e6, 2_0000, 0)
        );
        vm.stopPrank();
        uint256 vaultBefore = gusd.balanceOf(address(sg));
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(topUp, _updateData(H100, 2_0000));

        IGpuPerpEngine.Position memory pos = engine.positions(alice, H100, true);
        // Settled at the touch: owed 60e6 (the one-sided A→B window) + borrow
        // 12e6 swept to the vault; earned 144e6 (bob's side paid) accrued
        // into the balance. Collateral = 4_990e6 − 72e6 + 1_000e6 − 10e6 fee.
        assertEq(pos.earnedFunding, 144_000_000);
        assertEq(pos.collateral, 5_908_000_000);
        assertEq(pos.sizeUsd, 20_000e6);
        assertEq(engine.totalEarnedFunding(), 144_000_000);
        assertEq(engine.claimableOf(alice), 0);
        assertEq(engine.claimableOf(bob), 0);
        assertEq(gusd.balanceOf(address(sg)) - vaultBefore, 72_000_000);
        // Reserve floor = three terms: claimable 0 + reservedPnl 0 (the mark
        // never moved) + the carried balances.
        assertEq(sg.perpReserved(), 144_000_000);
    }

    /// Two touches accrue into the balance; the close folds the whole
    /// carried state plus the final un-accrued window, and the accumulator
    /// empties with the position.
    function test_twoTouchAccumulationFoldsAtClose() public {
        _openSkew();
        vm.startPrank(alice);
        gusd.approve(address(engine), type(uint256).max);
        uint256 topUp = engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 10_000e6, 1_000e6, 2_0000, 0)
        );
        vm.stopPrank();
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(topUp, _updateData(H100, 2_0000));
        assertEq(engine.positions(alice, H100, true).earnedFunding, 144_000_000);

        // One more epoch (OI 20k/40k — shorts still dominate: the ⅓ skew floors
        // the drift at 1_999_999_999_999_999 WAD, credit per long unit 2× =
        // 3_999_999_999_999_998), then close. The settlement earns
        // 79_999_999 more; the full close folds balance 144e6 + 79_999_999.
        vm.startPrank(alice);
        uint256 close = engine.createOrder(_order(H100, IGpuPerpEngine.OrderKind.MarketDecrease, true, 0, 0, 2_0000, 0));
        vm.stopPrank();
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(close, _updateData(H100, 2_0000));
        // due = released 5_908e6 − closeFee 20e6 − borrow 12e6 + 223_999_999.
        assertEq(engine.claimableOf(alice), 6_099_999_999);
        assertEq(engine.totalEarnedFunding(), 0);
        // Engine at rest: bob's escrowed collateral (20_000e6 − 0.1% fee).
        _assertEngineBalance(19_960_000_000);
    }

    /// The carried balance folds into the liquidation gate AND the `due`:
    /// a position whose earned funding was seeded by a top-up touch (here
    /// 144e6) liquidates with the credit counted — at $1.44 the uPnL-only
    /// equity is 311e6, but the credited equity is 495e6 and the whole
    /// balance rides into `due` before the 1% liqFee; the accumulator
    /// empties and the reserve floor collapses back to one term.
    function test_liquidationFoldsCarriedBalance() public {
        _openSkew();
        vm.startPrank(alice);
        gusd.approve(address(engine), type(uint256).max);
        uint256 topUp = engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 10_000e6, 1_000e6, 2_0000, 0)
        );
        vm.stopPrank();
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(topUp, _updateData(H100, 2_0000));
        assertEq(engine.positions(alice, H100, true).earnedFunding, 144_000_000);

        // One idle epoch (the ⅓-skew window accrues 79_999_999 more credit to
        // alice's index — drift floors at 1_999_999_999_999_999, credit 2× =
        // 3_999_999_999_999_998 — plus 6e14 borrow), then liquidate at $1.43:
        // uPnL −5_700e6, borrow 12e6 → equity 5_908 − 5_700 + 223_999_999 −
        // 12e6 = 419_999_999 < 500e6 maintenance (uPnL-only it would be
        // 196e6 — the carried credits widen the position's life).
        vm.warp(block.timestamp + 60);
        vm.prank(bob);
        engine.liquidate(alice, H100, true, _updateData(H100, 1_4300));
        // due = 419_999_999 − liqFee 200e6.
        assertEq(engine.claimableOf(alice), 219_999_999);
        assertEq(engine.totalClaimable(), 219_999_999);
        assertEq(engine.totalEarnedFunding(), 0);
        assertEq(engine.reservedPnl(), 0);
        assertEq(sg.perpReserved(), 219_999_999);
        assertEq(engine.positions(alice, H100, true).sizeUsd, 0);
        _assertEngineBalance(19_960_000_000);
    }
}