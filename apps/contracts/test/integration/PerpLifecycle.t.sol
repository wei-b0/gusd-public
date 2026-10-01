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

using Math for uint256;

/// @notice Full engine lifecycle with the real pull oracle: order validation,
///         increase (weighted entry), partial close, claim, full close — plus
///         the engine-at-rest balance invariant at every step.
abstract contract PerpBase is OracleReports {
    MockERC20 internal underlying;
    GUSD internal gusd;
    sgUSD internal sg;
    RevenueLedger internal ledger;
    GpuPerpEngine internal engine;

    address internal alice = makeAddr("alice"); // trader
    address internal bob = makeAddr("bob"); // keeper/executor

    /// == GpuPerpEngine.MIN_EXECUTION_FEE. Declared here (not type-level
    /// accessed) because solc's member lookup on the engine type is flaky
    /// across compile units ("not visible after argument-dependent lookup");
    /// the setUp sync-assert pins it to the contract's actual value.
    uint96 internal constant EXEC_FEE = 10_000;

    /// 20x leverage, 2.5% maintenance (of notional — half the 5% initial
    /// margin), 0.1% open/close, 1% liquidation, funding/borrow off (covered
    /// by dedicated suites).
    function _defaultParams() internal pure returns (IGpuPerpEngine.MarketParams memory) {
        return IGpuPerpEngine.MarketParams({
            maxLeverageBps: 200_000,
            maintenanceMarginBps: 250,
            openFeeBps: 10,
            closeFeeBps: 10,
            liquidationFeeBps: 100,
            fundingRatePpmPerSec: 0,
            borrowRatePpmPerSec: 0,
            maxOiUsd: 1_000_000e6,
            minCollateralUsd: 10e6,
            maxPositionUsd: 100_000e6
        });
    }

    function _order(
        bytes32 market,
        IGpuPerpEngine.OrderKind kind,
        bool isLong,
        uint128 size,
        uint128 collateral,
        uint128 acceptable,
        uint128 trigger
    ) internal pure returns (IGpuPerpEngine.OrderParams memory) {
        return IGpuPerpEngine.OrderParams({
            market: market,
            kind: kind,
            isLong: isLong,
            sizeDeltaUsd: size,
            collateralDeltaUsd: collateral,
            acceptablePrice: acceptable,
            triggerPrice: trigger,
            executionFee: EXEC_FEE
        });
    }

    /// @dev Engine at rest: balance == Σ open collateral + pending escrow
    ///      (this suite holds at most one pending order, supplied by caller).
    function _assertEngineBalance(uint256 escrowed) internal view {
        assertEq(IERC20(address(gusd)).balanceOf(address(engine)), escrowed, "engine at-rest balance");
    }

    function _createAndExecute(address who, IGpuPerpEngine.OrderParams memory p, uint256 price)
        internal
        returns (uint256 orderId)
    {
        vm.startPrank(who);
        gusd.approve(address(engine), type(uint256).max);
        orderId = engine.createOrder(p);
        vm.stopPrank();
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(orderId, _updateData(p.market, price));
    }

    function _openLong(address who, uint128 size, uint128 collateral, uint256 price)
        internal
        returns (uint256)
    {
        return _createAndExecute(
            who, _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, size, collateral, uint128(price), 0),
            price
        );
    }
}

contract PerpLifecycleTest is PerpBase {
    function setUp() public {
        _deployOracle();
        underlying = new MockERC20("USD Coin", "USDC", 6);
        gusd = new GUSD(IERC20(address(underlying)), address(this));
        sg = new sgUSD(IERC20(address(gusd)), address(this));
        ledger = new RevenueLedger(IERC20(address(gusd)), address(this));
        engine = new GpuPerpEngine(IERC20(address(gusd)), sg, oracle, address(ledger), address(this));
        assertEq(uint256(EXEC_FEE), uint256(engine.MIN_EXECUTION_FEE()), "exec fee sync");
        sg.setPerpEngine(address(engine));
        sg.setEngineMaxWithdrawPerBlock(type(uint256).max);
        _mintGusd(address(this), 2_000_000e6);
        gusd.approve(address(sg), type(uint256).max);
        sg.seed(1_000_000e6); // LP capital
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

    // ------------------------------------------------------- order validation

    function test_orderValidation() public {
        gusd.approve(address(engine), type(uint256).max);

        // Leverage cap: 30x > 20x.
        vm.expectRevert(abi.encodeWithSelector(IGpuPerpEngine.LeverageTooHigh.selector, 300_000, 200_000));
        engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 30_000e6, 1_000e6, 2_0000, 0)
        );

        // Min collateral on the RESULTING position.
        vm.expectRevert(abi.encodeWithSelector(IGpuPerpEngine.BelowMinCollateral.selector, 5e6, 10e6));
        engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 50e6, 5e6, 2_0000, 0)
        );

        // Position size cap.
        vm.expectRevert(abi.encodeWithSelector(IGpuPerpEngine.PositionTooLarge.selector, 150_000e6, 100_000e6));
        engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 150_000e6, 50_000e6, 2_0000, 0)
        );

        // Execution fee floor.
        IGpuPerpEngine.OrderParams memory p =
            _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 10_000e6, 1_000e6, 2_0000, 0);
        p.executionFee = 9_999;
        vm.expectRevert(abi.encodeWithSelector(IGpuPerpEngine.ExecutionFeeTooLow.selector, 9_999, 10_000));
        engine.createOrder(p);

        // Market orders require an acceptable price and must not carry a trigger.
        p.executionFee = 10_000;
        p.acceptablePrice = 0;
        vm.expectRevert(IGpuPerpEngine.ZeroAcceptablePrice.selector);
        engine.createOrder(p);
        p.acceptablePrice = 2_0000;
        p.triggerPrice = 1;
        vm.expectRevert(IGpuPerpEngine.UnexpectedTriggerPrice.selector);
        engine.createOrder(p);
    }

    /// The permissionless-execution delay: 0 stays legal (the dev posture
    /// executes instantly) and the cap can never lock a trader's armed order
    /// out for more than an hour.
    function test_minOrderDelayCap() public {
        engine.setMinOrderDelay(0);
        assertEq(engine.minOrderDelay(), 0);
        engine.setMinOrderDelay(3600);
        assertEq(engine.minOrderDelay(), 3600);
        vm.expectRevert(abi.encodeWithSelector(IGpuPerpEngine.OrderDelayTooHigh.selector, 3601, 3600));
        engine.setMinOrderDelay(3601);
    }

    function test_unknownMarketReverts() public {
        gusd.approve(address(engine), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IGpuPerpEngine.UnknownMarket.selector, bytes32(bytes("L40S_48GB"))));
        engine.createOrder(
            _order(bytes32(bytes("L40S_48GB")), IGpuPerpEngine.OrderKind.MarketIncrease, true, 10_000e6, 1_000e6, 2_0000, 0)
        );
    }

    // -------------------------------------------------------------- lifecycle

    function test_openIncreasePartialCloseClaim() public {
        uint256 aliceGusd = gusd.balanceOf(alice);
        uint256 lpBefore = gusd.balanceOf(address(sg));
        uint256 ledgerBefore = gusd.balanceOf(address(ledger));

        // Open 10x long: 10k notional, 1k collateral at $2.00.
        _openLong(alice, 10_000e6, 1_000e6, 2_0000);

        IGpuPerpEngine.Position memory pos = engine.positions(alice, H100, true);
        uint256 openFee = Math.mulDiv(10_000e6, 10, 10_000); // 10 units
        assertEq(pos.sizeUsd, 10_000e6);
        assertEq(pos.collateral, 1_000e6 - openFee); // 999_999_990
        assertEq(pos.entryPrice, 2_0000);
        _assertEngineBalance(pos.collateral);
        assertEq(gusd.balanceOf(address(ledger)), ledgerBefore + openFee);
        assertEq(gusd.balanceOf(alice), aliceGusd - 1_000e6 - 10_000); // escrow + exec fee
        assertEq(engine.totalClaimable(), 0);
        assertEq(sg.perpReserved(), 0);
        assertEq(engine.markets(H100).openNotionalLong, 10_000e6);

        // Increase at $2.50: weighted entry (1e10×20000 + 1e10×25000)/2e10.
        _createAndExecute(
            alice, _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 10_000e6, 2_000e6, 2_5000, 0), 2_5000
        );
        pos = engine.positions(alice, H100, true);
        assertEq(pos.entryPrice, 22_500);
        assertEq(pos.sizeUsd, 20_000e6);
        assertEq(pos.collateral, 990_000_000 + 2_000e6 - 10_000_000); // − 2nd open fee (10 gUSD)
        _assertEngineBalance(pos.collateral);

        // Partial close half at $3.00: +33.3% on 10k notional.
        uint256 dueBefore = engine.totalClaimable();
        _createAndExecute(
            alice, _order(H100, IGpuPerpEngine.OrderKind.MarketDecrease, true, 10_000e6, 0, 2_5000, 0), 3_0000
        );
        uint256 pnlShare = Math.mulDiv(10_000e6, 3_0000 - 22_500, 22_500); // 1_250_000_000
        uint256 released = Math.mulDiv(2_980_000_000, 10_000e6, 20_000e6); // 1_490_000_000
        uint256 closeFee = 10_000_000; // 10 gUSD on 10k notional
        uint256 due = released + pnlShare - closeFee; // 2_730_000_000
        assertEq(pnlShare, 3_333_333_333); // 1e10 × 7500/22500, floored
        assertEq(released, 1_490_000_000);
        assertEq(engine.totalClaimable(), dueBefore + due);
        assertEq(engine.claimableOf(alice), due);
        // The claimable exceeded the released collateral (profit) → the vault
        // takes nothing here; the engine drops to the remaining collateral.
        pos = engine.positions(alice, H100, true);
        assertEq(pos.sizeUsd, 10_000e6);
        assertEq(pos.collateral, 1_490_000_000);
        _assertEngineBalance(pos.collateral);

        // Claim pays from the vault — which first received the released
        // remainder (collateral share − close fee = 1_480e6): the vault
        // holds it as backing for the claimable it now owes.
        uint256 before = gusd.balanceOf(alice);
        vm.prank(alice);
        engine.claim(type(uint256).max, alice);
        assertEq(gusd.balanceOf(alice), before + due);
        assertEq(engine.claimableOf(alice), 0);
        assertEq(engine.totalClaimable(), 0);
        assertEq(gusd.balanceOf(address(sg)), lpBefore + 1_480_000_000 - due);

        // Full close at $1.50: loss on the remaining 10k, absorbed by the
        // released collateral; overflow to the vault.
        _createAndExecute(
            alice, _order(H100, IGpuPerpEngine.OrderKind.MarketDecrease, true, 0, 0, 1_0000, 0), 1_5000
        );
        assertEq(engine.positions(alice, H100, true).sizeUsd, 0);
        assertEq(engine.markets(H100).openNotionalLong, 0);
        // Loss ceils: 1e10 × 7500/22500 = 3_333_333_333.33 → 3_333_333_334.
        // due = 1_490_000_000 − 3_333_333_334 − 10_000_000 < 0 → nothing
        // claimable; the vault absorbs the released remainder (1_480e6) AND
        // the loss beyond the position's collateral.
        assertEq(engine.claimableOf(alice), 0);
        assertEq(gusd.balanceOf(address(sg)), lpBefore + 2_960_000_000 - due);
        _assertEngineBalance(0);
    }

    function test_staleDecreaseCancelsWhenPositionGone() public {
        _openLong(alice, 10_000e6, 1_000e6, 2_0000);
        vm.startPrank(alice);
        gusd.approve(address(engine), type(uint256).max);
        // A pending decrease larger than the position can't be created (reduce-only).
        vm.expectRevert(abi.encodeWithSelector(IGpuPerpEngine.SizeExceedsPosition.selector, 20_000e6, 10_000e6));
        engine.createOrder(_order(H100, IGpuPerpEngine.OrderKind.MarketDecrease, true, 20_000e6, 0, 2_0000, 0));
        // Arm a pending partial decrease…
        uint256 stale = engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.MarketDecrease, true, 5_000e6, 0, 2_0000, 0)
        );
        // …then full-close ahead of it with a second order.
        uint256 closer = engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.MarketDecrease, true, 0, 0, 2_0000, 0)
        );
        vm.stopPrank();
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(closer, _updateData(H100, 2_0000));
        assertEq(engine.positions(alice, H100, true).sizeUsd, 0);

        // The stale order executes to a honest cancel: fee refunded.
        uint256 before = gusd.balanceOf(alice);
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(stale, _updateData(H100, 2_0000));
        assertEq(uint8(engine.orders(stale).status), uint8(IGpuPerpEngine.OrderStatus.Cancelled));
        assertEq(gusd.balanceOf(alice), before + EXEC_FEE);
        _assertEngineBalance(0);
    }

    function test_cancelRefundsEscrow() public {
        uint256 before = gusd.balanceOf(alice);
        vm.startPrank(alice);
        gusd.approve(address(engine), type(uint256).max);
        uint256 orderId = engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 10_000e6, 1_000e6, 2_0000, 0)
        );
        assertEq(gusd.balanceOf(alice), before - 1_000e6 - 10_000);
        assertEq(IERC20(address(gusd)).balanceOf(address(engine)), 1_000e6 + 10_000);
        engine.cancelOrder(orderId);
        assertEq(gusd.balanceOf(alice), before);
        _assertEngineBalance(0);
        assertEq(uint8(engine.orders(orderId).status), uint8(IGpuPerpEngine.OrderStatus.Cancelled));

        // Someone else cannot cancel.
        uint256 o2 = engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 10_000e6, 1_000e6, 2_0000, 0)
        );
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IGpuPerpEngine.NotOrderAccount.selector, bob, alice));
        engine.cancelOrder(o2);
    }

    function test_executionDelayAndFeeToExecutor() public {
        uint256 before = gusd.balanceOf(bob);
        vm.startPrank(alice);
        gusd.approve(address(engine), type(uint256).max);
        uint256 orderId = engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 10_000e6, 1_000e6, 2_0000, 0)
        );
        vm.stopPrank();
        // Before the delay: revert, order still armed.
        vm.prank(bob);
        uint64 readyAt = uint64(block.timestamp) + engine.minOrderDelay();
        vm.expectRevert(abi.encodeWithSelector(IGpuPerpEngine.OrderDelayPending.selector, orderId, readyAt));
        engine.executeOrder(orderId, _updateData(H100, 2_0000));
        assertEq(uint8(engine.orders(orderId).status), uint8(IGpuPerpEngine.OrderStatus.Pending));
        // After the delay: permissionless fill, fee to the executor.
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(orderId, _updateData(H100, 2_0000));
        assertEq(gusd.balanceOf(bob), before + EXEC_FEE);
    }

    function test_acceptablePriceGuardsFills() public {
        vm.startPrank(alice);
        gusd.approve(address(engine), type(uint256).max);
        uint256 orderId = engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 10_000e6, 1_000e6, 1_5000, 0)
        );
        vm.stopPrank();
        _nextEpoch();
        // Fill at $2.00 > $1.50 bound → revert, order stays armed, escrow intact.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IGpuPerpEngine.UnacceptablePrice.selector, 2_0000, 1_5000, true));
        engine.executeOrder(orderId, _updateData(H100, 2_0000));
        assertEq(uint8(engine.orders(orderId).status), uint8(IGpuPerpEngine.OrderStatus.Pending));
        assertEq(IERC20(address(gusd)).balanceOf(address(engine)), 1_000e6 + 10_000);
        // Next epoch fills at $1.40 ≤ $1.50.
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(orderId, _updateData(H100, 1_4000));
        assertEq(engine.positions(alice, H100, true).entryPrice, 1_4000);
    }

    function test_shortEntryAndProfit() public {
        // Short 10k at $2.00, close at $1.50 → +25% of notional.
        _createAndExecute(
            alice, _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, false, 10_000e6, 1_000e6, 2_0000, 0), 2_0000
        );
        IGpuPerpEngine.Position memory pos = engine.positions(alice, H100, false);
        assertEq(pos.entryPrice, 2_0000);
        assertEq(engine.markets(H100).openNotionalShort, 10_000e6);
        assertEq(engine.markets(H100).openNotionalLong, 0);
        _createAndExecute(
            alice, _order(H100, IGpuPerpEngine.OrderKind.MarketDecrease, false, 0, 0, 1_5000, 0), 1_5000
        );
        uint256 pnl = Math.mulDiv(10_000e6, 2_0000 - 1_5000, 2_0000); // 2_500_000_000
        // Floor payout of the profit; close fee comes off the released collateral.
        assertEq(engine.claimableOf(alice), 990_000_000 + pnl - 10_000_000);
        _assertEngineBalance(0);
    }

    function test_engineBalanceInvariantAcrossFlows() public {
        _openLong(alice, 10_000e6, 1_000e6, 2_0000);
        vm.startPrank(alice);
        gusd.approve(address(engine), type(uint256).max);
        uint256 pending = engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 5_000e6, 500e6, 2_0000, 0)
        );
        vm.stopPrank();
        _assertEngineBalance(engine.positions(alice, H100, true).collateral + 500e6 + 10_000);
        vm.prank(alice);
        engine.cancelOrder(pending);
        _assertEngineBalance(engine.positions(alice, H100, true).collateral);
    }
}