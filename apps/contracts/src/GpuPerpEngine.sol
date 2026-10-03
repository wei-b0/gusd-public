// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IGpuOracle} from "./oracle/IGpuOracle.sol";
import {ReportCodec} from "./oracle/ReportCodec.sol";
import {IGpuPerpEngine} from "./interfaces/IGpuPerpEngine.sol";
import {ISgUSD} from "./interfaces/ISgUSD.sol";
import {GpuId} from "./libraries/GpuId.sol";
import {PerpMath} from "./libraries/PerpMath.sol";
import {PerpFunding} from "./libraries/PerpFunding.sol";
import {PerpLiquidation} from "./libraries/PerpLiquidation.sol";
import {PerpViews} from "./libraries/PerpViews.sol";

/// @title GpuPerpEngine
/// @notice GMX v2-style oracle perpetuals over GPU price reports, settled in
///         gUSD. Isolated margin, one position per (account, gpuId, isLong).
///         Orders are two-stage: `createOrder` locks collateral + execution
///         fee; any keeper (permissionless, after `minOrderDelay`) fetches a
///         fresh pull-oracle attestation and `executeOrder` consumes it
///         against the order's acceptable-price bounds / trigger conditions.
///         The report price is the ONLY fill price: one price per
///         (gpuId, epoch), so acceptable-price bounds and triggers are
///         evaluated against exactly one number per epoch.
/// @dev Accounting doctrine (see PROTOCOL.md, perp section): the vault never
///      loses a wei — fees ceil, payouts floor, debts ceil, entry prices
///      round against the trader. Decreases/liquidations settle atomically
///      into `claimableOf` (pure accounting — settlement NEVER reverts for
///      vault liquidity) and `claim` pays out of the sgUSD vault, partially
///      when the vault is short. The engine holds nothing at rest except
///      open-position collateral and pending-order escrow:
///      `gUSD.balanceOf(this) == Σ openCollateral + Σ pending (collateral + executionFee)`.
///      The engine pushes `perpReserved = totalClaimable + reservedPnl +
///      totalEarnedFunding` to sgUSD after every mutation so ordinary sgUSD
///      redemptions cannot drain funds reserved for perp liabilities.
/// @dev Pull-oracle doctrine (GPUIssuance's): state-changing paths CONSUME
///      the report; views VERIFY it — never a cached price. Liquidation is
///      deliberately executable while paused: it reduces protocol risk.
contract GpuPerpEngine is IGpuPerpEngine, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    IERC20 public immutable gUSD;
    ISgUSD public immutable sgusd;
    IGpuOracle public immutable oracle;
    address public immutable revenueLedger;

    /// @notice Minimum escrowed fee per order (0.01 gUSD) — the executor's
    ///         gas reimbursement floor.
    uint96 public constant MIN_EXECUTION_FEE = 10_000;

    uint32 public minOrderDelay;
    uint256 internal _orderNonce;

    mapping(bytes32 => Market) internal _markets;
    mapping(bytes32 => bool) internal _marketExists;
    mapping(uint256 => Order) internal _orders;
    mapping(bytes32 => Position) internal _positions;
    /// @dev key = keccak(abi.encode(account, gpuId, isLong, kind)) → pending orderId (0 = none).
    mapping(bytes32 => uint256) internal _activeTrigger;
    mapping(address => uint256) public claimableOf;
    /// @dev A struct (not bare uint256 vars) so the deployed execution
    ///      libraries can receive the totals as storage pointers.
    Totals internal _totals;

    /// @notice Total unsettled claimable across all accounts.
    function totalClaimable() external view returns (uint256) {
        return _totals.totalClaimable;
    }

    /// @notice Σ positive uPnL reserved at last-touch prices.
    function reservedPnl() external view returns (uint256) {
        return _totals.reservedPnl;
    }

    /// @notice Σ carried earned-funding balances over live positions.
    function totalEarnedFunding() external view returns (uint256) {
        return _totals.totalEarnedFunding;
    }

    constructor(IERC20 gUSD_, ISgUSD sgusd_, IGpuOracle oracle_, address revenueLedger_, address initialOwner)
        Ownable(initialOwner)
    {
        if (address(sgusd_) == address(0) || address(oracle_) == address(0) || revenueLedger_ == address(0)) {
            revert ZeroAddress();
        }
        gUSD = gUSD_;
        sgusd = sgusd_;
        oracle = oracle_;
        revenueLedger = revenueLedger_;
        minOrderDelay = 15;
    }

    // ------------------------------------------------------------ storage views

    function markets(bytes32 gpuId) external view returns (Market memory) {
        return _markets[gpuId];
    }

    function marketExists(bytes32 gpuId) external view returns (bool) {
        return _marketExists[gpuId];
    }

    function orders(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function positions(address account, bytes32 gpuId, bool isLong) external view returns (Position memory) {
        return _positions[_positionKey(account, gpuId, isLong)];
    }

    function activeTrigger(address account, bytes32 gpuId, bool isLong, uint8 kind) external view returns (uint256) {
        return _activeTrigger[_triggerKey(account, gpuId, isLong, kind)];
    }

    function orderNonce() external view returns (uint256) {
        return _orderNonce;
    }

    // ------------------------------------------------------------------ admin

    function createMarket(bytes32 gpuId, MarketParams calldata params) external onlyOwner {
        GpuId.validate(gpuId);
        if (_marketExists[gpuId]) revert MarketAlreadyExists(gpuId);
        _validateParams(gpuId, params);
        Market storage m = _markets[gpuId];
        m.enabled = true;
        m.params = params;
        m.fundingUpdatedAt = uint64(block.timestamp);
        _marketExists[gpuId] = true;
        emit MarketCreated(gpuId, params);
    }

    function setMarketParams(bytes32 gpuId, MarketParams calldata params) external onlyOwner {
        if (!_marketExists[gpuId]) revert UnknownMarket(gpuId);
        _validateParams(gpuId, params);
        Market storage m = _markets[gpuId];
        // Accrue under the OLD rates first — a rate change must never apply
        // retroactively to the un-accrued window (lazy accrual otherwise
        // charges the whole idle gap at the new rate).
        PerpFunding.accrue(m, gpuId, uint64(block.timestamp));
        m.params = params;
        emit MarketParamsUpdated(gpuId, params);
    }

    function setMarketEnabled(bytes32 gpuId, bool enabled) external onlyOwner {
        if (!_marketExists[gpuId]) revert UnknownMarket(gpuId);
        _markets[gpuId].enabled = enabled;
        emit MarketEnabled(gpuId, enabled);
    }

    /// @notice Upper cap on the order delay — permissionless execution must
    ///         never be locked out for more than an hour (a delay of 0 stays
    ///         legal: the dev posture uses instant execution).
    uint32 public constant MAX_ORDER_DELAY = 3600;

    function setMinOrderDelay(uint32 seconds_) external onlyOwner {
        if (seconds_ > MAX_ORDER_DELAY) revert OrderDelayTooHigh(seconds_, MAX_ORDER_DELAY);
        minOrderDelay = seconds_;
        emit MinOrderDelaySet(seconds_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _validateParams(bytes32 gpuId, MarketParams calldata p) internal pure {
        // maxLeverageBps: 1x = 10_000. Initial margin at max leverage is
        // size/maxLeverage = size × 1e4/maxLeverageBps of notional, so both
        // the maintenance margin and the open fee must stay below it —
        // mmBps × maxLeverageBps < 1e8 (⇔ mmBps < 1e4/lev) and
        // openFeeBps × maxLeverageBps < 1e8 — or a full-leverage position
        // opens below maintenance / underflows its collateral.
        if (p.maxLeverageBps < PerpMath.BPS) revert InvalidMarketParams(gpuId);
        if (p.maintenanceMarginBps == 0 || p.maintenanceMarginBps >= PerpMath.BPS) {
            revert InvalidMarketParams(gpuId);
        }
        if (uint256(p.maintenanceMarginBps) * p.maxLeverageBps >= 1e8) revert InvalidMarketParams(gpuId);
        if (uint256(p.maxLeverageBps) * p.openFeeBps >= 1e8) revert InvalidMarketParams(gpuId);
        if (p.openFeeBps > PerpMath.MAX_FEE_BPS) revert InvalidMarketParams(gpuId);
        if (p.closeFeeBps > PerpMath.MAX_FEE_BPS) revert InvalidMarketParams(gpuId);
        if (p.liquidationFeeBps > PerpMath.MAX_FEE_BPS) revert InvalidMarketParams(gpuId);
        if (p.fundingRatePpmPerSec > PerpMath.MAX_RATE_PPM_PER_SEC) revert InvalidMarketParams(gpuId);
        if (p.borrowRatePpmPerSec > PerpMath.MAX_RATE_PPM_PER_SEC) revert InvalidMarketParams(gpuId);
        if (p.maxOiUsd == 0 || p.minCollateralUsd == 0 || p.maxPositionUsd == 0) {
            revert InvalidMarketParams(gpuId);
        }
    }

    // ------------------------------------------------------------------ users

    function createOrder(OrderParams calldata p) external whenNotPaused nonReentrant returns (uint256 orderId) {
        if (!_marketExists[p.market]) revert UnknownMarket(p.market);
        if (p.executionFee < MIN_EXECUTION_FEE) revert ExecutionFeeTooLow(p.executionFee, MIN_EXECUTION_FEE);
        Market storage m = _markets[p.market];

        if (p.kind == OrderKind.MarketIncrease) {
            if (!m.enabled) revert MarketDisabled(p.market);
            if (p.sizeDeltaUsd == 0 || p.collateralDeltaUsd == 0) revert ZeroAmount();
            if (p.acceptablePrice == 0) revert ZeroAcceptablePrice();
            if (p.triggerPrice != 0) revert UnexpectedTriggerPrice();
            // Min-collateral applies to the RESULTING position, not the delta
            // (a small top-up on a healthy position is legitimate).
            uint128 currentColl = _positions[_positionKey(msg.sender, p.market, p.isLong)].collateral;
            if (uint256(currentColl) + p.collateralDeltaUsd < m.params.minCollateralUsd) {
                revert BelowMinCollateral(uint256(currentColl) + p.collateralDeltaUsd, m.params.minCollateralUsd);
            }
            uint256 leverageBps = uint256(p.sizeDeltaUsd).mulDiv(
                PerpMath.BPS, p.collateralDeltaUsd, Math.Rounding.Ceil
            );
            if (leverageBps > m.params.maxLeverageBps) revert LeverageTooHigh(leverageBps, m.params.maxLeverageBps);
            if (p.sizeDeltaUsd > m.params.maxPositionUsd) {
                revert PositionTooLarge(p.sizeDeltaUsd, m.params.maxPositionUsd);
            }
            gUSD.safeTransferFrom(msg.sender, address(this), uint256(p.collateralDeltaUsd) + p.executionFee);
        } else if (p.kind == OrderKind.MarketDecrease) {
            // Decreases are allowed even on a disabled market: an exit path
            // must survive an emergency disable (increases may not).
            // sizeDeltaUsd == 0 means close the whole remaining position.
            if (p.acceptablePrice == 0) revert ZeroAcceptablePrice();
            if (p.triggerPrice != 0) revert UnexpectedTriggerPrice();
            if (p.collateralDeltaUsd != 0) revert ZeroAmount();
            uint128 held = _positions[_positionKey(msg.sender, p.market, p.isLong)].sizeUsd;
            if (p.sizeDeltaUsd > held) revert SizeExceedsPosition(p.sizeDeltaUsd, held);
            gUSD.safeTransferFrom(msg.sender, address(this), p.executionFee);
        } else {
            // Trigger orders (StopLoss / TakeProfit): conditional decrease,
            // condition re-verified against the report at execution.
            Position storage pos = _positions[_positionKey(msg.sender, p.market, p.isLong)];
            if (pos.sizeUsd == 0) revert NoPosition(msg.sender, p.market, p.isLong);
            if (p.triggerPrice == 0) revert ZeroTriggerPrice();
            if (p.acceptablePrice != 0 || p.collateralDeltaUsd != 0) revert UnexpectedAcceptablePrice();
            gUSD.safeTransferFrom(msg.sender, address(this), p.executionFee);
            // One active trigger per kind: creating replaces the old one
            // (cancelled with its fee refunded to the account).
            uint256 existing = _activeTrigger[_triggerKey(msg.sender, p.market, p.isLong, uint8(p.kind))];
            if (existing != 0) {
                _cancelOrder(existing, msg.sender);
            }
        }

        orderId = ++_orderNonce;
        if (p.kind == OrderKind.StopLoss || p.kind == OrderKind.TakeProfit) {
            _activeTrigger[_triggerKey(msg.sender, p.market, p.isLong, uint8(p.kind))] = orderId;
        }
        _orders[orderId] = Order({
            account: msg.sender,
            kind: p.kind,
            status: OrderStatus.Pending,
            isLong: p.isLong,
            sizeDeltaUsd: p.sizeDeltaUsd,
            collateralDeltaUsd: p.collateralDeltaUsd,
            acceptablePrice: p.acceptablePrice,
            triggerPrice: p.triggerPrice,
            executionFee: p.executionFee,
            createdAt: uint64(block.timestamp),
            market: p.market
        });
        emit OrderCreated(
            orderId, msg.sender, p.market, p.kind, p.isLong, p.sizeDeltaUsd, p.collateralDeltaUsd,
            p.acceptablePrice, p.triggerPrice, p.executionFee
        );
    }

    /// @notice Account cancellation — exempt from the execution delay.
    function cancelOrder(uint256 orderId) external nonReentrant {
        _cancelOrder(orderId, msg.sender);
    }

    function _cancelOrder(uint256 orderId, address caller) internal {
        Order storage o = _orders[orderId];
        if (o.account == address(0)) revert UnknownOrder(orderId);
        if (o.status != OrderStatus.Pending) revert OrderNotPending(orderId, o.status);
        if (caller != o.account) revert NotOrderAccount(caller, o.account);
        o.status = OrderStatus.Cancelled;
        if (o.kind == OrderKind.MarketIncrease) {
            // Escrowed collateral + fee both go back.
            gUSD.safeTransfer(o.account, uint256(o.collateralDeltaUsd) + o.executionFee);
            emit OrderCancelled(orderId, o.account, o.kind, o.executionFee, o.collateralDeltaUsd);
        } else {
            gUSD.safeTransfer(o.account, o.executionFee);
            emit OrderCancelled(orderId, o.account, o.kind, o.executionFee, 0);
        }
        if (o.kind == OrderKind.StopLoss || o.kind == OrderKind.TakeProfit) {
            delete _activeTrigger[_triggerKey(o.account, o.market, o.isLong, uint8(o.kind))];
        }
    }

    /// @notice Claim — exempt from the pause (it pays the trader what the
    ///         protocol already owes; the same risk-reducing class as
    ///         liquidation and cancel). Clamped to the counter and to the
    ///         vault's per-block payout capacity; the remainder stays
    ///         claimable.
    function claim(uint256 amount, address to) external nonReentrant returns (uint256 paid) {
        if (to == address(0)) revert ZeroAddress();
        uint256 want = amount < claimableOf[msg.sender] ? amount : claimableOf[msg.sender];
        if (want == 0) revert NothingToClaim();
        paid = sgusd.perpWithdraw(to, want);
        claimableOf[msg.sender] -= paid;
        _totals.totalClaimable -= paid;
        _pushReservation();
        emit Claimed(msg.sender, to, amount, paid);
    }

    // -------------------------------------------------------------- execution

    function executeOrder(uint256 orderId, bytes calldata updateData) external whenNotPaused nonReentrant {
        Order storage o = _orders[orderId];
        if (o.status != OrderStatus.Pending) revert OrderNotPending(orderId, o.status);
        uint64 readyAt = o.createdAt + minOrderDelay;
        if (block.timestamp < readyAt) revert OrderDelayPending(orderId, readyAt);
        Market storage m = _markets[o.market];
        if (o.kind == OrderKind.MarketIncrease && !m.enabled) revert MarketDisabled(o.market);
        PerpFunding.accrue(m, o.market, uint64(block.timestamp));
        if (o.kind == OrderKind.MarketIncrease) {
            _executeIncrease(o, m, orderId, updateData);
        } else {
            _executeDecrease(o, m, orderId, updateData);
        }
    }

    function _executeIncrease(Order storage o, Market storage m, uint256 orderId, bytes calldata updateData)
        internal
    {
        (IGpuOracle.Report calldata report, bytes calldata signature) = ReportCodec.decode(updateData);
        uint256 price = oracle.consume(o.market, report, signature);
        // Acceptable price: longs buy cheap (≤ bound), shorts sell dear (≥ bound).
        if (o.isLong ? price > o.acceptablePrice : price < o.acceptablePrice) {
            revert UnacceptablePrice(price, o.acceptablePrice, o.isLong);
        }
        MarketParams storage params = m.params;
        uint128 sideOi = o.isLong ? m.openNotionalLong : m.openNotionalShort;
        if (uint256(sideOi) + o.sizeDeltaUsd > params.maxOiUsd) {
            revert MaxOiExceeded(uint256(sideOi) + o.sizeDeltaUsd, params.maxOiUsd);
        }
        bytes32 pk = _positionKey(o.account, o.market, o.isLong);
        Position storage pos = _positions[pk];
        if (uint256(pos.sizeUsd) + o.sizeDeltaUsd > params.maxPositionUsd) {
            revert PositionTooLarge(uint256(pos.sizeUsd) + o.sizeDeltaUsd, params.maxPositionUsd);
        }

        // Escrow → executor fee, ledger fee, position collateral.
        gUSD.safeTransfer(msg.sender, o.executionFee);
        uint256 openFee = PerpMath.feeBps(o.sizeDeltaUsd, params.openFeeBps);
        if (openFee > 0) gUSD.safeTransfer(revenueLedger, openFee);

        uint256 charged = 0;
        uint256 earned = 0;
        if (pos.sizeUsd > 0) {
            (charged, earned) = _chargeFunding(pos, m, o.isLong);
            if (earned > 0) {
                // Earned funding accrues INTO the position (equity-inclusive;
                // monetizes only at close/liquidation) — `claimableOf`
                // receives close proceeds only. The credit checkpoint has
                // already re-snapped in settle(), so the balance field is
                // what carries the credit forward.
                pos.earnedFunding += uint128(earned);
                _totals.totalEarnedFunding += earned;
            }
            // The payer's funding charge is LP revenue: sweep it to the vault
            // NOW. The charge was deducted from pos.collateral, so the gUSD
            // backing it must leave the engine in the same transaction —
            // holding it here would strand unowned gUSD between touches and
            // break the at-rest identity (balance == Σ pos.collateral +
            // escrow). This is the same destination the decrease settlement
            // remainder carries collected funding to.
            if (charged > 0) gUSD.safeTransfer(address(sgusd), charged);
        }

        uint256 newSize = uint256(pos.sizeUsd) + o.sizeDeltaUsd;
        uint256 newCollateral = uint256(pos.collateral) - charged + o.collateralDeltaUsd - openFee;
        uint256 newEntry = pos.sizeUsd == 0
            ? price
            : Math.mulDiv(
                uint256(pos.sizeUsd) * pos.entryPrice + uint256(o.sizeDeltaUsd) * price,
                1,
                newSize,
                // Against the trader: a higher entry hurts longs, a lower one hurts shorts.
                o.isLong ? Math.Rounding.Ceil : Math.Rounding.Floor
            );
        if (pos.sizeUsd == 0) {
            // Fresh position: its debt clock starts at the CURRENT
            // cumulatives — it owes funding/borrow only for the time it
            // actually holds OI, not for the market's accrued history.
            pos.fundingFeeCheckpoint =
                o.isLong ? m.fundingChargePerUnitLong : m.fundingChargePerUnitShort;
            pos.fundingCreditCheckpoint =
                o.isLong ? m.fundingCreditPerUnitLong : m.fundingCreditPerUnitShort;
            pos.borrowCheckpoint = m.borrowChargePerUnit;
        }

        int256 uPnl = PerpMath.pnl(newSize, newEntry, o.isLong, price);
        _setReserveShare(pos, uPnl);
        pos.sizeUsd = uint128(newSize);
        pos.collateral = uint128(newCollateral);
        pos.entryPrice = uint128(newEntry);
        if (pos.openedAt == 0) pos.openedAt = uint64(block.timestamp);
        if (o.isLong) {
            // Side OI accumulates across ALL positions on this side (many
            // traders can hold longs) — never overwrite with this position's
            // new size. Bounded by the MaxOiExceeded check above.
            m.openNotionalLong += o.sizeDeltaUsd;
        } else {
            m.openNotionalShort += o.sizeDeltaUsd;
        }
        o.status = OrderStatus.Executed;
        _pushReservation();
        emit PositionIncreased(
            o.account, o.market, o.isLong, newSize, newCollateral, newEntry,
            // Post-touch checkpoints — settle() re-snapshotted them above (or
            // the fresh-position branch pinned them), so these are the exact
            // values the indexer/keeper needs for offline debt math, clamp
            // rewinds included.
            pos.fundingFeeCheckpoint, pos.fundingCreditCheckpoint, pos.borrowCheckpoint,
            pos.earnedFunding
        );
        emit OrderExecuted(
            orderId, msg.sender, o.account, o.market, o.kind, o.isLong, price, o.executionFee,
            // claimableDelta is 0 on increases: earned funding accrues into
            // the position's balance (carried on PositionIncreased), never
            // into the claimable counter. fundingNet stays the informative
            // earned − charged log value.
            o.sizeDeltaUsd, 0, openFee, int256(earned) - int256(charged), 0
        );
    }

    function _executeDecrease(Order storage o, Market storage m, uint256 orderId, bytes calldata updateData)
        internal
    {
        (IGpuOracle.Report calldata report, bytes calldata signature) = ReportCodec.decode(updateData);
        uint256 price = oracle.consume(o.market, report, signature);
        bytes32 pk = _positionKey(o.account, o.market, o.isLong);
        Position storage pos = _positions[pk];
        if (pos.sizeUsd == 0) {
            // Position gone while the order was pending: cancel honestly.
            _cancelOrder(orderId, o.account);
            return;
        }
        uint128 sizeDelta = o.sizeDeltaUsd == 0
            ? pos.sizeUsd
            : (o.sizeDeltaUsd > pos.sizeUsd ? pos.sizeUsd : o.sizeDeltaUsd);
        if (o.kind == OrderKind.MarketDecrease) {
            // Longs close dear (≥ bound), shorts close cheap (≤ bound).
            if (o.isLong ? price < o.acceptablePrice : price > o.acceptablePrice) {
                revert UnacceptablePrice(price, o.acceptablePrice, !o.isLong);
            }
        } else {
            _checkTrigger(o.kind, o.isLong, price, o.triggerPrice);
        }

        // Snapshot the debt checkpoints BEFORE settle — the closed slice's funding
        // share must be computed at the same per-unit deltas the full
        // settlement reads (settle re-snapshots the checkpoints to the
        // current cumulatives). The credit checkpoint needs no snapshot: its
        // earned folds into the position's balance below and slices from
        // there.
        uint128 feeCkpt = pos.fundingFeeCheckpoint;
        uint128 borrowCkpt = pos.borrowCheckpoint;
        PerpFunding.Settlement memory s = PerpFunding.settle(m, pos, o.isLong);
        // The whole earned state — carried balance + this settlement's
        // un-accrued credit — slices pro-rata at close: fold before slicing.
        uint256 balanceTotal = uint256(pos.earnedFunding) + s.earned;
        uint256 released = uint256(pos.collateral).mulDiv(sizeDelta, pos.sizeUsd, Math.Rounding.Floor);
        int256 pnlShare = PerpMath.pnl(sizeDelta, pos.entryPrice, o.isLong, price);
        uint256 closeFee = PerpMath.feeBps(sizeDelta, m.params.closeFeeBps);
        // Pro-rata funding attribution: the closed slice settles only ITS
        // share of the position's accrued funding — charges ceil, credits
        // floor (the same per-unit rounding doctrine everywhere else). The
        // remainder's unattributed debt rewinds into its checkpoints below;
        // its earned share stays in the balance field, so a partial close
        // neither forgives the remainder's debt nor forfeits its credits
        // (full closes attribute everything anyway).
        uint256 sliceOwed = PerpMath.fundingOwed(
            sizeDelta, o.isLong ? m.fundingChargePerUnitLong : m.fundingChargePerUnitShort, feeCkpt
        );
        uint256 sliceBorrow = PerpMath.fundingOwed(sizeDelta, m.borrowChargePerUnit, borrowCkpt);
        // Earned share: a floor slice of the whole balance — the remainder
        // keeps `balanceTotal − sliceEarned` (floor remainder ≥ its pro-rata
        // share → conservation without clamping).
        uint256 sliceEarned = balanceTotal.mulDiv(sizeDelta, pos.sizeUsd, Math.Rounding.Floor);
        int256 raw = int256(released) + pnlShare - int256(closeFee)
            - int256(sliceOwed + sliceBorrow) + int256(sliceEarned);
        uint256 due = raw > 0 ? uint256(raw) : 0;

        if (due > 0) _creditClaimable(o.account, o.market, due);
        // Physical flows out of the engine's released funds: close fee to the
        // ledger, the whole non-fee remainder to the vault. The claimable
        // `due` is the VAULT's liability (paid at claim time) — the vault's
        // net is `released − closeFee − due = −pnl + collected funding`,
        // exactly the counterparty side of the trader's settlement. Sending
        // the full remainder here is what keeps the engine's at-rest balance
        // at Σ openCollateral + escrow; settlement itself never touches vault
        // liquidity beyond this always-succeeding transfer (crunch safety).
        uint256 paidLedger = closeFee > released ? released : closeFee;
        if (paidLedger > 0) gUSD.safeTransfer(revenueLedger, paidLedger);
        uint256 toVault = released > paidLedger ? released - paidLedger : 0;
        if (toVault > 0) gUSD.safeTransfer(address(sgusd), toVault);
        // Executor fee from escrow.
        gUSD.safeTransfer(msg.sender, o.executionFee);
        o.status = OrderStatus.Executed;
        if (o.kind == OrderKind.StopLoss || o.kind == OrderKind.TakeProfit) {
            delete _activeTrigger[_triggerKey(o.account, o.market, o.isLong, uint8(o.kind))];
        }

        uint256 remaining = uint256(pos.sizeUsd) - sizeDelta;
        if (o.isLong) {
            m.openNotionalLong -= sizeDelta;
        } else {
            m.openNotionalShort -= sizeDelta;
        }
        if (remaining == 0) {
            _totals.reservedPnl -= pos.reserveShare;
            // The accumulator tracks Σ carried balances — the un-accrued
            // `s.earned` share of balanceTotal was never added to it (only
            // touch-folded earned is), so it must not be subtracted either.
            _totals.totalEarnedFunding -= pos.earnedFunding;
            delete _positions[pk];
            emit PositionClosed(o.account, o.market, o.isLong, price);
        } else {
            pos.sizeUsd = uint128(remaining);
            pos.collateral -= uint128(released);
            // The remainder keeps its unattributed funding debt — uncollected
            // charges rewind into the fresh checkpoints (floor, clamped at
            // the cumulative's own delta, the same clamp pattern
            // _chargeFunding uses); its earned share is carried in the
            // balance field (balanceTotal − sliceEarned), so no credit
            // rewind exists anymore.
            // Accumulator: replace this position's old carried balance with
            // its new one (the settlement's earned folds in here at the
            // slice boundary — it was never in the accumulator before).
            uint256 carried = uint256(pos.earnedFunding);
            pos.earnedFunding = uint128(balanceTotal - sliceEarned);
            _totals.totalEarnedFunding =
                _totals.totalEarnedFunding - carried + uint256(pos.earnedFunding);
            _rewindFunding(
                pos, m, o.isLong, remaining, feeCkpt, borrowCkpt,
                s.owed - sliceOwed, s.borrow - sliceBorrow
            );
            _setReserveShare(pos, PerpMath.pnl(remaining, pos.entryPrice, o.isLong, price));
            emit PositionDecreased(
                o.account, o.market, o.isLong, sizeDelta, pnlShare,
                int256(sliceEarned) - int256(sliceOwed + sliceBorrow), paidLedger, due,
                remaining, uint256(pos.collateral),
                pos.fundingFeeCheckpoint, pos.fundingCreditCheckpoint, pos.borrowCheckpoint,
                pos.earnedFunding
            );
        }
        _pushReservation();
        emit OrderExecuted(
            orderId, msg.sender, o.account, o.market, o.kind, o.isLong, price, o.executionFee,
            sizeDelta, pnlShare, paidLedger,
            int256(sliceEarned) - int256(sliceOwed + sliceBorrow), due
        );
    }

    /// @notice Permissionless liquidation — allowed while paused (it reduces
    ///         protocol risk). Full close only. The body lives in the
    ///         deployed `PerpLiquidation` library (EIP-170 split); the
    ///         delegatecall executes in this contract's storage context.
    function liquidate(address account, bytes32 gpuId, bool isLong, bytes calldata updateData) external nonReentrant {
        PerpLiquidation.liquidate(
            _markets, _marketExists, _positions, claimableOf, _totals, gUSD, sgusd, oracle, revenueLedger,
            account, gpuId, isLong, updateData
        );
    }

    // ------------------------------------------------------------- internals

    /// @dev Settles funding, deducts charges from the position's collateral
    ///      (clamped — collateral never goes negative) and rewinds the
    ///      checkpoints for any uncollected remainder so the debt follows the
    ///      position instead of evaporating. Credits are NOT charged here.
    function _chargeFunding(Position storage pos, Market storage m, bool isLong)
        internal
        returns (uint256 charged, uint256 earned)
    {
        PerpFunding.Settlement memory s = PerpFunding.settle(m, pos, isLong);
        uint256 chargedFunding = s.owed > pos.collateral ? uint256(pos.collateral) : s.owed;
        uint256 remaining = uint256(pos.collateral) - chargedFunding;
        uint256 chargedBorrow = s.borrow > remaining ? remaining : s.borrow;
        charged = chargedFunding + chargedBorrow;
        earned = s.earned;
        if (chargedFunding < s.owed) {
            // Keep the uncollected skew-funding debt in the checkpoint. The
            // rewind is clamped at the cumulative's own delta: ceil/floor
            // asymmetry can push the raw rewind past the delta on dust
            // positions, which would underflow the snapshot.
            uint128 feeCum = isLong ? m.fundingChargePerUnitLong : m.fundingChargePerUnitShort;
            uint256 delta = feeCum - pos.fundingFeeCheckpoint;
            uint256 rewind = (s.owed - chargedFunding).mulDiv(PerpMath.FUNDING_SCALE, pos.sizeUsd, Math.Rounding.Floor);
            if (rewind > delta) rewind = delta;
            pos.fundingFeeCheckpoint = feeCum - uint128(rewind);
        }
        if (chargedBorrow < s.borrow) {
            uint256 delta = m.borrowChargePerUnit - pos.borrowCheckpoint;
            uint256 rewind = (s.borrow - chargedBorrow).mulDiv(PerpMath.FUNDING_SCALE, pos.sizeUsd, Math.Rounding.Floor);
            if (rewind > delta) rewind = delta;
            pos.borrowCheckpoint = m.borrowChargePerUnit - uint128(rewind);
        }
    }

    /// @dev After a partial decrease, rewinds the remainder's share of the
    ///      settled funding DEBT into the freshly re-snapshotted checkpoints
    ///      — floor-rounded and clamped at the cumulative delta the
    ///      settlement actually read. (Earned credits are not rewound: the
    ///      remainder's share is carried in `pos.earnedFunding` —
    ///      `balanceTotal − sliceEarned`.) The clamp reads the PRE-settle
    ///      checkpoints (`*Ckpt0`): settle has already re-snapshotted the
    ///      position's, so its own delta is zero. The amount inputs are the
    ///      FULL-size settlement's minus the closed slice's attributed share.
    function _rewindFunding(
        Position storage pos,
        Market storage m,
        bool isLong,
        uint256 remaining,
        uint128 feeCkpt0,
        uint128 borrowCkpt0,
        uint256 owedRem,
        uint256 borrowRem
    ) internal {
        uint128 feeCum = isLong ? m.fundingChargePerUnitLong : m.fundingChargePerUnitShort;
        uint256 delta = feeCum - feeCkpt0;
        uint256 rewind = owedRem.mulDiv(PerpMath.FUNDING_SCALE, remaining, Math.Rounding.Floor);
        if (rewind > delta) rewind = delta;
        pos.fundingFeeCheckpoint = feeCum - uint128(rewind);

        delta = m.borrowChargePerUnit - borrowCkpt0;
        rewind = borrowRem.mulDiv(PerpMath.FUNDING_SCALE, remaining, Math.Rounding.Floor);
        if (rewind > delta) rewind = delta;
        pos.borrowCheckpoint = m.borrowChargePerUnit - uint128(rewind);
    }

    function _creditClaimable(address account, bytes32 gpuId, uint256 amount) internal {
        claimableOf[account] += amount;
        _totals.totalClaimable += amount;
        emit ClaimableSettled(account, gpuId, amount);
    }

    /// @dev Updates the position's share of `reservedPnl` (its positive uPnL
    ///      at the touch price) and re-pushes the vault reservation.
    function _setReserveShare(Position storage pos, int256 uPnl) internal {
        uint256 share = uPnl > 0 ? uint256(uPnl) : 0;
        if (share > type(uint128).max) share = type(uint128).max;
        _totals.reservedPnl = _totals.reservedPnl - pos.reserveShare + share;
        pos.reserveShare = uint128(share);
    }

    function _pushReservation() internal {
        // Three liability terms: settled close proceeds, unrealized gains at
        // last-touch prices, and the carried earned-funding balances.
        sgusd.setPerpReserved(
            _totals.totalClaimable + _totals.reservedPnl + _totals.totalEarnedFunding
        );
    }

    function _checkTrigger(OrderKind kind, bool isLong, uint256 price, uint128 trigger) internal pure {
        bool met = kind == OrderKind.TakeProfit
            ? (isLong ? price >= trigger : price <= trigger)
            : (isLong ? price <= trigger : price >= trigger);
        if (!met) revert TriggerNotMet(kind, isLong, price, trigger);
    }

    function _positionKey(address account, bytes32 gpuId, bool isLong) internal pure returns (bytes32) {
        return keccak256(abi.encode(account, gpuId, isLong));
    }

    function _triggerKey(address account, bytes32 gpuId, bool isLong, uint8 kind) internal pure returns (bytes32) {
        return keccak256(abi.encode(account, gpuId, isLong, kind));
    }

    // ------------------------------------------------------------------ views

    /// @notice Execution-identical probe: VERIFIES the exact report execution
    ///         would accept (never consumes). Bodies live in the deployed
    ///         `PerpViews` library (EIP-170 split) — see there for semantics.
    function getPosition(address account, bytes32 gpuId, bool isLong, bytes calldata updateData)
        external
        view
        returns (PositionView memory v)
    {
        v = PerpViews.getPosition(_markets, _marketExists, _positions, oracle, account, gpuId, isLong, updateData);
    }

    function liquidatableAt(address account, bytes32 gpuId, bool isLong, bytes calldata updateData)
        external
        view
        returns (bool)
    {
        return PerpViews.liquidatableAt(_markets, _marketExists, _positions, oracle, account, gpuId, isLong, updateData);
    }

    function getMarket(bytes32 gpuId) external view returns (MarketView memory v) {
        v = PerpViews.getMarket(_markets, _marketExists, gpuId);
    }
}