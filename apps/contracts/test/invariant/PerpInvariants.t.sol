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

/// @notice Invariant suite: three traders, one market, a permissionless
///         keeper, live price and clock. The handlers mirror the production
///         actors (traders create, the keeper fills with the CURRENT price
///         after the delay, liquidations probe with the verify-only view
///         first) and the suite pins the engine's money identities:
///
///   1. engine gUSD balance == Σ open collateral + Σ pending-order escrow
///   2. Σ claimableOf(account) == totalClaimable
///   3. Σ position sizeUsd == market openNotional per side
///   4. sgUSD.perpReserved == totalClaimable + reservedPnl
///
/// The escrow side of (1) is ghost-tracked incrementally in the harness
/// (createOrder escrows collateral+fee for increases, the fee alone for
/// decreases/triggers; cancel/execute releases it). Everything else is read
/// straight off the chain — no mirror of the engine's math.
contract PerpInvariantTest is OracleReports {
    GUSD internal gusd;
    sgUSD internal sg;
    RevenueLedger internal ledger;
    GpuPerpEngine internal engine;

    address[3] internal traders;
    uint256 internal currentPrice = 20_000; // $2.00, 4-dec; moved by reprice()
    uint256 internal harnessNonce; // engine order ids are sequential from 1
    uint256 internal ghostEscrow;
    uint256[] internal pendingIds;

    uint96 internal constant EXEC_FEE = 10_000; // == GpuPerpEngine.MIN_EXECUTION_FEE

    function setUp() public {
        _deployOracle(); // warps to 1_000_000; 60s epochs
        underlying = new MockERC20("USD Coin", "USDC", 6);
        gusd = new GUSD(IERC20(address(underlying)), address(this));
        sg = new sgUSD(IERC20(address(gusd)), address(this));
        ledger = new RevenueLedger(IERC20(address(gusd)), address(this));
        engine = new GpuPerpEngine(IERC20(address(gusd)), sg, oracle, address(ledger), address(this));
        sg.setPerpEngine(address(engine));
        sg.setEngineMaxWithdrawPerBlock(type(uint256).max);
        _mintGusd(address(this), 20_000_000e6);
        gusd.approve(address(sg), type(uint256).max);
        sg.seed(20_000_000e6); // deep LP capital so crunches are rare, not never
        for (uint256 i; i < 3; ++i) {
            traders[i] = makeAddr(string.concat("trader", vm.toString(i)));
            _mintGusd(traders[i], 50_000_000e6);
        }
        IGpuPerpEngine.MarketParams memory p = IGpuPerpEngine.MarketParams({
            maxLeverageBps: 200_000,
            maintenanceMarginBps: 250,
            openFeeBps: 10,
            closeFeeBps: 10,
            liquidationFeeBps: 100,
            fundingRatePpmPerSec: 10, // small but non-zero: exercises lazy accrual
            borrowRatePpmPerSec: 5,
            maxOiUsd: 1_000_000e6,
            minCollateralUsd: 10e6,
            maxPositionUsd: 100_000e6
        });
        engine.createMarket(H100, p);
        // Only the harness's handler set may drive the fuzzer: the default
        // target sweep would call pause/setMarketEnabled/burn/etc. on every
        // deployed contract (observed as 94% handler-call reverts).
        targetContract(address(this));
    }

    MockERC20 internal underlying;

    function _mintGusd(address to, uint256 amt) internal {
        underlying.mint(to, amt);
        vm.startPrank(to);
        underlying.approve(address(gusd), type(uint256).max);
        gusd.mint(amt, to);
        vm.stopPrank();
    }

    // ------------------------------------------------------------- handlers

    /// @dev Acceptable-price bound with 25% slack so the keeper usually fills:
    ///      increase-long / decrease-short fill only when price ≤ bound;
    ///      increase-short / decrease-long only when price ≥ bound.
    function _acceptable(bool isIncrease, bool isLong) internal view returns (uint128) {
        bool ceilBound = (isIncrease && isLong) || (!isIncrease && !isLong);
        return uint128(ceilBound ? currentPrice * 5 / 4 : currentPrice * 3 / 4);
    }

    function _escrowOf(IGpuPerpEngine.Order memory o) internal pure returns (uint256) {
        return o.kind == IGpuPerpEngine.OrderKind.MarketIncrease
            ? uint256(o.collateralDeltaUsd) + o.executionFee
            : uint256(o.executionFee);
    }

    function _removePending(uint256 idx) internal {
        pendingIds[idx] = pendingIds[pendingIds.length - 1];
        pendingIds.pop();
    }

    function openIncrease(uint256 actorSeed, uint256 sizeSeed, uint256 collSeed, bool isLong) public {
        address t = traders[actorSeed % 3];
        uint128 coll = uint128(1_000e6 + bound(collSeed, 0, 20_000e6));
        // ≤ 19x so the 20x leverage check always passes on the created order.
        uint128 size = uint128(1_000e6 + bound(sizeSeed, 0, uint256(coll) * 19));
        if (size > 100_000e6) size = 100_000e6; // maxPositionUsd

        vm.startPrank(t);
        gusd.approve(address(engine), type(uint256).max);
        uint256 id = engine.createOrder(
            IGpuPerpEngine.OrderParams({
                market: H100,
                kind: IGpuPerpEngine.OrderKind.MarketIncrease,
                isLong: isLong,
                sizeDeltaUsd: size,
                collateralDeltaUsd: coll,
                acceptablePrice: _acceptable(true, isLong),
                triggerPrice: 0,
                executionFee: EXEC_FEE
            })
        );
        vm.stopPrank();
        ghostEscrow += uint256(coll) + EXEC_FEE;
        pendingIds.push(id);
        ++harnessNonce;
    }

    function closeDecrease(uint256 actorSeed, uint256 fracSeed, bool isLong) public {
        address t = traders[actorSeed % 3];
        IGpuPerpEngine.Position memory pos = engine.positions(t, H100, isLong);
        if (pos.sizeUsd == 0) return;
        // 0 means "close all" (the engine clamps a full close); otherwise a
        // random slice of the live size.
        uint128 sizeDelta =
            fracSeed % 4 == 0 ? 0 : uint128(bound(fracSeed, 1, uint256(pos.sizeUsd)));
        vm.startPrank(t);
        gusd.approve(address(engine), type(uint256).max);
        uint256 id = engine.createOrder(
            IGpuPerpEngine.OrderParams({
                market: H100,
                kind: IGpuPerpEngine.OrderKind.MarketDecrease,
                isLong: isLong,
                sizeDeltaUsd: sizeDelta,
                collateralDeltaUsd: 0,
                acceptablePrice: _acceptable(false, isLong),
                triggerPrice: 0,
                executionFee: EXEC_FEE
            })
        );
        vm.stopPrank();
        ghostEscrow += EXEC_FEE;
        pendingIds.push(id);
        ++harnessNonce;
    }

    function armTrigger(uint256 actorSeed, bool isLong, uint256 kindSeed, uint256 trigSeed) public {
        address t = traders[actorSeed % 3];
        IGpuPerpEngine.OrderKind kind =
            kindSeed % 2 == 0 ? IGpuPerpEngine.OrderKind.StopLoss : IGpuPerpEngine.OrderKind.TakeProfit;
        uint8 kindU8 = uint8(kind);
        // Replacing an armed trigger cancels the old one WITH a fee refund.
        uint256 old = engine.activeTrigger(t, H100, isLong, kindU8);

        vm.startPrank(t);
        gusd.approve(address(engine), type(uint256).max);
        uint256 id = engine.createOrder(
            IGpuPerpEngine.OrderParams({
                market: H100,
                kind: kind,
                isLong: isLong,
                sizeDeltaUsd: 0,
                collateralDeltaUsd: 0,
                acceptablePrice: 0,
                triggerPrice: uint128(bound(trigSeed, 5_000, 50_000)),
                executionFee: EXEC_FEE
            })
        );
        vm.stopPrank();
        ghostEscrow += EXEC_FEE;
        if (old != 0) {
            ghostEscrow -= EXEC_FEE; // replaced order's fee refunded
            for (uint256 i; i < pendingIds.length; ++i) {
                if (pendingIds[i] == old) _removePending(i);
            }
        }
        pendingIds.push(id);
        ++harnessNonce;
    }

    function keeperExecute(uint256 orderIdxSeed) public {
        if (pendingIds.length == 0) return;
        uint256 idx = orderIdxSeed % pendingIds.length;
        uint256 id = pendingIds[idx];
        IGpuPerpEngine.Order memory o = engine.orders(id);
        if (o.status != IGpuPerpEngine.OrderStatus.Pending) {
            _removePending(idx);
            return;
        }
        _nextEpoch(); // always past minOrderDelay
        vm.prank(makeAddr("keeper"));
        engine.executeOrder(id, _updateData(o.market, currentPrice));
        ghostEscrow -= _escrowOf(o);
        _removePending(idx);
    }

    function cancelPending(uint256 orderIdxSeed) public {
        if (pendingIds.length == 0) return;
        uint256 idx = orderIdxSeed % pendingIds.length;
        uint256 id = pendingIds[idx];
        IGpuPerpEngine.Order memory o = engine.orders(id);
        if (o.status != IGpuPerpEngine.OrderStatus.Pending) {
            _removePending(idx);
            return;
        }
        vm.prank(o.account);
        engine.cancelOrder(id);
        ghostEscrow -= _escrowOf(o);
        _removePending(idx);
    }

    function keeperLiquidate(uint256 actorSeed, bool isLong) public {
        address t = traders[actorSeed % 3];
        IGpuPerpEngine.Position memory pos = engine.positions(t, H100, isLong);
        if (pos.sizeUsd == 0) return;
        // Keeper-style pre-check with the verify-only view; consume only if
        // the probe says the position is below maintenance.
        if (!engine.liquidatableAt(t, H100, isLong, _updateData(H100, currentPrice))) return;
        vm.prank(makeAddr("keeper"));
        engine.liquidate(t, H100, isLong, _updateData(H100, currentPrice));
    }

    function claimSome(uint256 actorSeed, uint256 amtSeed) public {
        address t = traders[actorSeed % 3];
        uint256 c = engine.claimableOf(t);
        if (c == 0) return;
        uint256 amt = bound(amtSeed, 1, c);
        vm.prank(t);
        engine.claim(amt, t);
    }

    function warpEpochs(uint256 n) public {
        vm.warp(block.timestamp + 60 * (bound(n, 1, 10)));
    }

    function reprice(uint256 seed) public {
        currentPrice = bound(seed, 10_000, 40_000); // $1.00 – $4.00
    }

    // ------------------------------------------------------------ invariants

    function invariant_engineBalanceEqualsCollateralPlusEscrow() public view {
        uint256 collSum;
        for (uint256 i; i < 3; ++i) {
            collSum += engine.positions(traders[i], H100, true).collateral;
            collSum += engine.positions(traders[i], H100, false).collateral;
        }
        assertEq(gusd.balanceOf(address(engine)), collSum + ghostEscrow, "engine at-rest balance");
    }

    function invariant_claimableSumEqualsTotal() public view {
        uint256 sum;
        for (uint256 i; i < 3; ++i) sum += engine.claimableOf(traders[i]);
        assertEq(sum, engine.totalClaimable(), "claimable sum");
    }

    function invariant_openNotionalMatchesPositions() public view {
        IGpuPerpEngine.Market memory m = engine.markets(H100);
        uint256 longSum;
        uint256 shortSum;
        for (uint256 i; i < 3; ++i) {
            longSum += engine.positions(traders[i], H100, true).sizeUsd;
            shortSum += engine.positions(traders[i], H100, false).sizeUsd;
        }
        assertEq(longSum, uint256(m.openNotionalLong), "long OI");
        assertEq(shortSum, uint256(m.openNotionalShort), "short OI");
    }

    function invariant_perpReservedEqualsLiabilities() public view {
        assertEq(
            sg.perpReserved(),
            engine.totalClaimable() + engine.reservedPnl() + engine.totalEarnedFunding(),
            "perpReserved"
        );
    }

    /// The carried earned-funding balances are engine-accounting liabilities
    /// outside its gUSD balance — the accumulator must always equal their
    /// sum, or the reserve floor drifts and throttles LP redemptions.
    function invariant_earnedFundingSumEqualsTotal() public view {
        uint256 sum;
        for (uint256 i; i < 3; ++i) {
            sum += engine.positions(traders[i], H100, true).earnedFunding;
            sum += engine.positions(traders[i], H100, false).earnedFunding;
        }
        assertEq(sum, engine.totalEarnedFunding(), "earnedFunding sum");
    }
}