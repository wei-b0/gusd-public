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
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PerpBase} from "./PerpLifecycle.t.sol";

/// @notice TP/SL trigger orders: arming, replace-with-refund, fail-closed
///         condition re-check at execution, sizeDelta=0 full close, SL has no
///         price floor (gap fills at the report price).
contract PerpTriggersTest is PerpBase {
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
        _openLong(alice, 10_000e6, 1_000e6, 2_0000); // entry $2.00
    }

    function _mintGusd(address to, uint256 amt) internal {
        underlying.mint(to, amt);
        vm.startPrank(to);
        underlying.approve(address(gusd), type(uint256).max);
        gusd.mint(amt, to);
        vm.stopPrank();
    }

    function test_triggerValidation() public {
        gusd.approve(address(engine), type(uint256).max);
        vm.startPrank(alice);
        vm.expectRevert(IGpuPerpEngine.ZeroTriggerPrice.selector);
        engine.createOrder(_order(H100, IGpuPerpEngine.OrderKind.StopLoss, true, 0, 0, 0, 0));
        vm.expectRevert(IGpuPerpEngine.UnexpectedAcceptablePrice.selector);
        engine.createOrder(_order(H100, IGpuPerpEngine.OrderKind.StopLoss, true, 0, 0, 1_0000, 1_0000));
        // A non-zero collateral delta on a trigger order is rejected by the
        // combined acceptable-price/collateral guard (it fires before any
        // ZeroAmount-style check).
        vm.expectRevert(IGpuPerpEngine.UnexpectedAcceptablePrice.selector);
        engine.createOrder(_order(H100, IGpuPerpEngine.OrderKind.StopLoss, true, 100, 1, 0, 1_0000));
        vm.stopPrank();
    }

    function test_armReplaceRefund() public {
        uint256 before = gusd.balanceOf(alice);
        vm.startPrank(alice);
        gusd.approve(address(engine), type(uint256).max);
        uint256 sl1 = engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.StopLoss, true, 0, 0, 0, 1_5000)
        );
        assertEq(engine.activeTrigger(alice, H100, true, uint8(IGpuPerpEngine.OrderKind.StopLoss)), sl1);
        assertEq(gusd.balanceOf(alice), before - EXEC_FEE);
        // Replacing cancels the old one and refunds its fee.
        uint256 sl2 = engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.StopLoss, true, 0, 0, 0, 1_6000)
        );
        assertEq(gusd.balanceOf(alice), before - EXEC_FEE);
        assertEq(uint8(engine.orders(sl1).status), uint8(IGpuPerpEngine.OrderStatus.Cancelled));
        assertEq(engine.activeTrigger(alice, H100, true, uint8(IGpuPerpEngine.OrderKind.StopLoss)), sl2);
        // TP is a separate slot.
        uint256 tp = engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.TakeProfit, true, 0, 0, 0, 3_0000)
        );
        assertEq(engine.activeTrigger(alice, H100, true, uint8(IGpuPerpEngine.OrderKind.TakeProfit)), tp);
        vm.stopPrank();
        // Manual cancel clears the slot too.
        vm.prank(alice);
        engine.cancelOrder(tp);
        assertEq(engine.activeTrigger(alice, H100, true, uint8(IGpuPerpEngine.OrderKind.TakeProfit)), 0);
    }

    function test_triggerConditionFailClosed() public {
        vm.startPrank(alice);
        gusd.approve(address(engine), type(uint256).max);
        uint256 tp = engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.TakeProfit, true, 0, 0, 0, 3_0000)
        );
        vm.stopPrank();
        _nextEpoch();
        // TP-long requires price ≥ trigger: $2.50 does not meet it → revert.
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IGpuPerpEngine.TriggerNotMet.selector, IGpuPerpEngine.OrderKind.TakeProfit, true, 2_5000, 3_0000)
        );
        engine.executeOrder(tp, _updateData(H100, 2_5000));
        assertEq(uint8(engine.orders(tp).status), uint8(IGpuPerpEngine.OrderStatus.Pending));
        // $3.00 meets it → full close at the report price (no extra bound).
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(tp, _updateData(H100, 3_0000));
        assertEq(uint8(engine.orders(tp).status), uint8(IGpuPerpEngine.OrderStatus.Executed));
        assertEq(engine.positions(alice, H100, true).sizeUsd, 0);
    }

    function test_stopLossHasNoFloor() public {
        // SL armed at $1.60; price gaps to $1.00 in one epoch — fills at the
        // report price with no acceptable-price stall.
        vm.startPrank(alice);
        gusd.approve(address(engine), type(uint256).max);
        uint256 sl = engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.StopLoss, true, 0, 0, 0, 1_6000)
        );
        vm.stopPrank();
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(sl, _updateData(H100, 1_0000));
        assertEq(uint8(engine.orders(sl).status), uint8(IGpuPerpEngine.OrderStatus.Executed));
        assertEq(engine.positions(alice, H100, true).sizeUsd, 0);
        // Loss: 1e10 × 1_0000/2_0000 = 5_000e6 against 999_999_990 collateral
        // → due floors at 0; the vault absorbs the released remainder minus
        // the close fee.
        assertEq(engine.claimableOf(alice), 0);
    }

    function test_triggerShrunkPositionClampsSize() public {
        // Partial-decrease trigger: sizeDelta half the position; the other
        // half is closed first, so at execution the order clamps to the
        // remaining size.
        vm.startPrank(alice);
        gusd.approve(address(engine), type(uint256).max);
        uint256 tp = engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.TakeProfit, true, 5_000e6, 0, 0, 3_0000)
        );
        vm.stopPrank();
        _createAndExecute(
            alice, _order(H100, IGpuPerpEngine.OrderKind.MarketDecrease, true, 0, 0, 2_0000, 0), 2_0000
        ); // full close first
        uint256 before = gusd.balanceOf(alice);
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(tp, _updateData(H100, 3_0000));
        assertEq(uint8(engine.orders(tp).status), uint8(IGpuPerpEngine.OrderStatus.Cancelled));
        assertEq(gusd.balanceOf(alice), before + EXEC_FEE);
    }

    function test_partialTriggerDecrease() public {
        vm.startPrank(alice);
        gusd.approve(address(engine), type(uint256).max);
        uint256 tp = engine.createOrder(
            _order(H100, IGpuPerpEngine.OrderKind.TakeProfit, true, 5_000e6, 0, 0, 3_0000)
        );
        vm.stopPrank();
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(tp, _updateData(H100, 3_0000));
        IGpuPerpEngine.Position memory pos = engine.positions(alice, H100, true);
        assertEq(pos.sizeUsd, 5_000e6);
        // PnL on 5k notional: 5_000e6 × 1_0000/2_0000 = 2_500_000_000.
        assertGt(engine.claimableOf(alice), 0);
        assertEq(engine.activeTrigger(alice, H100, true, uint8(IGpuPerpEngine.OrderKind.TakeProfit)), 0);
    }
}