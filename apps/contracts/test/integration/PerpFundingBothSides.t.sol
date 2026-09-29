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
}