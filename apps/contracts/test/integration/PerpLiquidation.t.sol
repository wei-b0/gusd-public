// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {OracleReports} from "../utils/OracleReports.sol";
import {GUSD} from "../../src/GUSD.sol";
import {sgUSD} from "../../src/sgUSD.sol";
import {RevenueLedger} from "../../src/RevenueLedger.sol";
import {GpuPerpEngine} from "../../src/GpuPerpEngine.sol";
import {IGpuPerpEngine} from "../../src/interfaces/IGpuPerpEngine.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PerpBase} from "./PerpLifecycle.t.sol";

/// @notice Liquidation: fail-closed probe (healthy → revert), fee to the
///         executor, residual equity to claimable, remainder/bad debt to the
///         vault, OI cleanup, works while paused.
contract PerpLiquidationTest is PerpBase {
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
        engine.createMarket(H100, _defaultParams());
    }

    function _mintGusd(address to, uint256 amt) internal {
        underlying.mint(to, amt);
        vm.startPrank(to);
        underlying.approve(address(gusd), type(uint256).max);
        gusd.mint(amt, to);
        vm.stopPrank();
    }

    /// 10x long: collateral 1_000e6, size 10_000e6, entry $2.00. Stored
    /// collateral is 990e6 (0.1% open fee). Equity hits the 2.5% maintenance
    /// line (250e6) when uPnL ≤ −740e6, i.e. price ≤ 1.8520.
    function _openTenX() internal {
        _openLong(alice, 10_000e6, 1_000e6, 2_0000);
    }

    function test_healthyLiquidationReverts() public {
        _openTenX();
        _nextEpoch();
        vm.prank(bob);
        // Equity at $1.91: 990e6 − 450e6 = 540e6 ≥ 250e6 maintenance.
        vm.expectRevert(abi.encodeWithSelector(IGpuPerpEngine.NotLiquidatable.selector, 540_000_000, 250_000_000));
        engine.liquidate(alice, H100, true, _updateData(H100, 1_9100));
        // Probe agrees via the verified view.
        assertFalse(engine.liquidatableAt(alice, H100, true, _updateData(H100, 1_8600)));
        assertTrue(engine.liquidatableAt(alice, H100, true, _updateData(H100, 1_8400)));
    }

    function test_liquidationFlows() public {
        _openTenX();
        uint256 execBefore = gusd.balanceOf(bob);
        uint256 vaultBefore = gusd.balanceOf(address(sg));
        _nextEpoch();
        // Price $1.85: uPnL = −1e10 × 1500/20000 = −750_000_000 → equity
        // 990_000_000 − 750_000_000 = 240_000_000 < 250_000_000.
        vm.prank(bob);
        engine.liquidate(alice, H100, true, _updateData(H100, 1_8500));

        // liqFee = ceil(1e10 × 100/1e4) = 100_000_000 (1% of notional).
        uint256 due = 240_000_000 - 100_000_000; // 140_000_000
        assertEq(gusd.balanceOf(bob), execBefore + 100_000_000);
        assertEq(engine.claimableOf(alice), due);
        assertEq(engine.totalClaimable(), due);
        // Vault receives the whole non-fee remainder of the released
        // collateral: 990_000_000 − 100_000_000 = 890_000_000. The 140e6
        // equity is a vault liability (claimable) paid later at claim.
        assertEq(gusd.balanceOf(address(sg)), vaultBefore + 890_000_000);
        assertEq(engine.positions(alice, H100, true).sizeUsd, 0);
        assertEq(engine.markets(H100).openNotionalLong, 0);
        assertEq(engine.reservedPnl(), 0);
        assertEq(sg.perpReserved(), due); // totalClaimable + reservedPnl pushed
        _assertEngineBalance(0);

        // The trader still claims from the vault.
        vm.prank(alice);
        engine.claim(type(uint256).max, alice);
        assertEq(gusd.balanceOf(alice), 100_000e6 - 1_000e6 - 10_000 + due);
    }

    function test_badDebtToVault() public {
        // 20x: collateral 500e6, size 10_000e6 (stored 490e6 after the open
        // fee). Price $1.00 → uPnL −5_000e6, equity = 490e6 − 5_000e6 < 0
        // → full bad debt.
        _createAndExecute(
            alice, _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 10_000e6, 500e6, 2_0000, 0), 2_0000
        );
        uint256 vaultBefore = gusd.balanceOf(address(sg));
        _nextEpoch();
        vm.prank(bob);
        engine.liquidate(alice, H100, true, _updateData(H100, 1_0000));
        // liqFee = 1% of notional (100_000_000) — clamped only by collateral.
        assertEq(gusd.balanceOf(bob), EXEC_FEE + 100_000_000);
        assertEq(engine.claimableOf(alice), 0);
        // Vault absorbs the untouched remainder of the collateral:
        // 490_000_000 − 100_000_000 = 390_000_000.
        assertEq(gusd.balanceOf(address(sg)), vaultBefore + 390_000_000);
        assertEq(engine.positions(alice, H100, true).sizeUsd, 0);
    }

    function test_liquidationWorksWhilePaused() public {
        _openTenX();
        engine.pause();
        // User flows are paused…
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        engine.createOrder(_order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 1_000e6, 100e6, 2_0000, 0));
        // …but liquidation is risk-reducing and stays live.
        _nextEpoch();
        vm.prank(bob);
        engine.liquidate(alice, H100, true, _updateData(H100, 1_8500));
        assertEq(engine.positions(alice, H100, true).sizeUsd, 0);
    }

    function test_shortLiquidation() public {
        // 10x short: collateral 1_000e6, size 10_000e6, entry $2.00. Price
        // $2.20 → uPnL = −1e10 × 2000/20000 = −1_000e6 → equity −10 < mm.
        _createAndExecute(
            alice, _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, false, 10_000e6, 1_000e6, 2_0000, 0), 2_0000
        );
        assertFalse(engine.liquidatableAt(alice, H100, false, _updateData(H100, 2_0500)));
        _nextEpoch();
        vm.prank(bob);
        engine.liquidate(alice, H100, false, _updateData(H100, 2_2000));
        assertEq(engine.positions(alice, H100, false).sizeUsd, 0);
        assertEq(engine.markets(H100).openNotionalShort, 0);
        assertEq(engine.claimableOf(alice), 0); // fully wiped
    }

    // ------------------------------------------------- funding-aware gate (G1)

    /// @dev bob longs 20k @ 2.0 (5x) — the paying side; alice shorts 10k @ 2.0
    ///      (10x) — the receiver whose liquidation we probe. Rates: funding
    ///      100 ppm/s, borrow off. Timeline (60s epochs): bob's window is 20s
    ///      with no OI; alice's is 60s one-sided long (long charge 6e15 WAD,
    ///      her checkpoints pin here at zero); the liquidation probe then
    ///      idles 600s, accruing 100×600×⅓-skew/1e6 ≈ 2e16 WAD to the long
    ///      charge and 2× that per short unit to alice's credit index —
    ///      earned ≈ 399_999_999 (floor) on her 10k notional.
    function _fundedRig() internal {
        IGpuPerpEngine.MarketParams memory p = _defaultParams();
        p.fundingRatePpmPerSec = 100; // 0.01%/s
        engine.setMarketParams(H100, p);
        _mintGusd(bob, 100_000e6);
        _createAndExecute(
            bob, _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 20_000e6, 4_000e6, 2_0000, 0), 2_0000
        );
        _createAndExecute(
            alice, _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, false, 10_000e6, 1_000e6, 2_0000, 0), 2_0000
        );
    }

    /// The receiver's earned funding pays at liquidation. At $2.2380 the
    /// short's uPnL is −1_190e6 and her earned credits 399_999_999 — equity
    /// 199_999_999 crosses the 250e6 maintenance line only as
    /// collateral − uPnL-loss + credits, and 99_999_999 of it settles to
    /// claimable after the 1% liqFee. Without the credits the equity is
    /// −200_000_001 and nothing settles.
    function test_liquidationPaysAccruedFundingCredit() public {
        _fundedRig();
        vm.warp(vm.getBlockTimestamp() + 600);
        vm.prank(bob);
        engine.liquidate(alice, H100, false, _updateData(H100, 2_2380));
        assertEq(engine.markets(H100).fundingCreditPerUnitShort, 39_999_999_999_999_998);
        assertEq(engine.claimableOf(alice), 99_999_999);
        assertEq(engine.totalClaimable(), 99_999_999);
        assertEq(engine.positions(alice, H100, false).sizeUsd, 0);
    }

    /// The gate counts the credits too. At $2.2180 the uPnL-only equity is
    /// −100_000_001 (a pre-G1 gate would have liquidated), but with the
    /// credits it is 339_999_999 — above the 250e6 line, so the gate refuses.
    /// A benign touch first: the verified view does NOT accrue, so its credit
    /// index still reads zero until the cumulatives are advanced onchain.
    function test_liquidationGateCountsCredit() public {
        _fundedRig();
        vm.warp(vm.getBlockTimestamp() + 600);
        vm.startPrank(bob);
        gusd.approve(address(engine), type(uint256).max);
        uint256 topUp =
            engine.createOrder(_order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 1_000e6, 100e6, 2_2180, 0));
        vm.stopPrank();
        _nextEpoch();
        vm.prank(alice);
        engine.executeOrder(topUp, _updateData(H100, 2_2180));
        // uPnL −1_090e6, earned 439_999_999 (660s to this touch), coll 990e6
        // → equity 339_999_999.
        IGpuPerpEngine.PositionView memory v = engine.getPosition(alice, H100, false, _updateData(H100, 2_2180));
        assertEq(v.equity, 339_999_999);
        assertFalse(v.liquidatable);
        // The gate agrees.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IGpuPerpEngine.NotLiquidatable.selector, 339_999_999, 250_000_000));
        engine.liquidate(alice, H100, false, _updateData(H100, 2_2180));
    }

    /// Claims pay the trader what the protocol already owes — the same
    /// risk-reducing class as liquidation, so the pause must not freeze them.
    function test_claimWorksWhilePaused() public {
        _openTenX();
        engine.pause();
        _nextEpoch();
        vm.prank(bob);
        engine.liquidate(alice, H100, true, _updateData(H100, 1_8500));
        assertEq(engine.claimableOf(alice), 140_000_000);
        vm.prank(alice);
        engine.claim(type(uint256).max, alice);
        assertEq(gusd.balanceOf(alice), 100_000e6 - 1_000e6 - 10_000 + 140_000_000);
        assertEq(engine.claimableOf(alice), 0);
    }
}