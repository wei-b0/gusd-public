// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IGpuOracle} from "../oracle/IGpuOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISgUSD} from "./ISgUSD.sol";

/// @title IGpuPerpEngine
/// @notice GPU perpetual futures on the pull oracle: gUSD-settled leveraged
///         long/short positions per GPU market (gpuId), isolated margin,
///         two-stage oracle execution (createOrder locks collateral + fee →
///         a keeper fetches a fresh attestation → executeOrder consumes it
///         against the user's acceptable price), GMX v2-style skew funding +
///         borrow fees, trigger orders for TP/SL, permissionless liquidation,
///         and claim-based settlement (closes settle into a claimable gUSD
///         balance; `claim` pays out of sgUSD vault liquidity, partially when
///         the vault is short).
/// @dev Isolated margin: one position per (account, gpuId, isLong). Size is
///      USD notional in 6-dec (gUSD units); prices are the oracle's 4-dec
///      `PRICE_SCALE` convention. Funding cumulatives are WAD-scaled
///      (1e18) "gUSD per gUSD of notional". Every executed order CONSUMES the
///      report (first-consumer-per-epoch binding); every view VERIFIES it
///      (the GPUIssuance quote doctrine).
interface IGpuPerpEngine {
    // ------------------------------------------------------------- config

    /// @notice Per-market risk parameters. Owner-settable, bounded by caps.
    struct MarketParams {
        uint32 maxLeverageBps; // notional/collateral cap, 1x = 10_000
        uint32 maintenanceMarginBps; // liquidation threshold, bps of notional
        uint32 openFeeBps;
        uint32 closeFeeBps;
        uint32 liquidationFeeBps; // executor reward, bps of notional
        uint32 fundingRatePpmPerSec; // skew funding, ppm of notional per second
        uint32 borrowRatePpmPerSec; // borrow fee (both sides), ppm per second
        uint128 maxOiUsd; // per-side open interest cap (6-dec USD)
        uint128 minCollateralUsd;
        uint128 maxPositionUsd;
    }

    /// @notice Per-market state: params, OI and cumulative funding.
    struct Market {
        bool enabled;
        MarketParams params;
        uint128 openNotionalLong; // Σ sizeUsd of open longs
        uint128 openNotionalShort;
        // Cumulative funding, WAD-scaled gUSD per gUSD notional:
        uint128 fundingChargePerUnitLong; // grows while longs pay shorts
        uint128 fundingChargePerUnitShort;
        uint128 fundingCreditPerUnitLong; // grows while longs receive
        uint128 fundingCreditPerUnitShort;
        uint128 borrowChargePerUnit; // charged to BOTH sides
        uint64 fundingUpdatedAt;
    }

    /// @notice An isolated-margin position. `entryPrice` is the 4-dec oracle
    ///         price convention; `sizeUsd`/`collateral` are 6-dec.
    struct Position {
        uint128 sizeUsd;
        uint128 collateral;
        uint128 entryPrice;
        uint128 fundingFeeCheckpoint; // snapshot of this side's charge cumulative
        uint128 fundingCreditCheckpoint; // snapshot of this side's credit cumulative
        uint128 borrowCheckpoint;
        uint128 reserveShare; // this position's contribution to `reservedPnl`
        uint64 openedAt;
    }

    enum OrderKind {
        MarketIncrease,
        MarketDecrease,
        StopLoss,
        TakeProfit
    }

    enum OrderStatus {
        None,
        Pending,
        Executed,
        Cancelled
    }

    /// @notice User order request. Increase orders lock `collateralDeltaUsd +
    ///         executionFee` at creation; decrease/trigger orders lock only
    ///         `executionFee`. Market orders must set `acceptablePrice`;
    ///         trigger orders must set `triggerPrice` and may use
    ///         `sizeDeltaUsd == 0` to close the whole remaining position.
    struct OrderParams {
        bytes32 market;
        OrderKind kind;
        bool isLong;
        uint128 sizeDeltaUsd;
        uint128 collateralDeltaUsd;
        uint128 acceptablePrice;
        uint128 triggerPrice;
        uint96 executionFee;
    }

    /// @notice Stored order (all of `OrderParams` plus lifecycle state).
    struct Order {
        address account;
        OrderKind kind;
        OrderStatus status;
        bool isLong;
        uint128 sizeDeltaUsd;
        uint128 collateralDeltaUsd;
        uint128 acceptablePrice;
        uint128 triggerPrice;
        uint96 executionFee;
        uint64 createdAt;
        bytes32 market;
    }

    /// @notice Position read through a verified report (view — never consumes).
    struct PositionView {
        Position position;
        int256 uPnL; // unrealized PnL at the report price (6-dec, signed)
        int256 equity; // collateral + uPnL − accrued debts
        uint256 maintenance;
        bool liquidatable;
        int256 fundingDue; // earned − owed − borrow, as last accrued on-chain
    }

    /// @notice Market read incl. pro-forma funding rates at current OI.
    struct MarketView {
        Market market;
        int256 fundingRateLongPpmPerSec; // signed: >0 longs pay, <0 longs receive
        int256 fundingRateShortPpmPerSec;
        int256 borrowRatePpmPerSec;
    }

    /// @notice Engine-level accounting totals. A storage struct (not bare
    ///         uint256 state vars) because the deployed execution libraries
    ///         receive them as storage pointers — scalars cannot be passed
    ///         as storage references to external functions.
    struct Totals {
        uint256 totalClaimable;
        uint256 reservedPnl;
    }

    // ------------------------------------------------------------- events

    event MarketCreated(bytes32 indexed gpuId, MarketParams params);
    event MarketParamsUpdated(bytes32 indexed gpuId, MarketParams params);
    event MarketEnabled(bytes32 indexed gpuId, bool enabled);
    event MinOrderDelaySet(uint32 seconds_);

    event OrderCreated(uint256 indexed orderId, address indexed account, bytes32 indexed gpuId, OrderKind kind, bool isLong, uint128 sizeDeltaUsd, uint128 collateralDeltaUsd, uint128 acceptablePrice, uint128 triggerPrice, uint96 executionFee);
    event OrderExecuted(uint256 indexed orderId, address indexed executor, address indexed account, bytes32 gpuId, OrderKind kind, bool isLong, uint256 execPrice, uint256 executionFeePaid, uint256 sizeDeltaUsd, int256 realizedPnl, uint256 feesPaid, int256 fundingNet, uint256 claimableDelta);
    event OrderCancelled(uint256 indexed orderId, address indexed account, OrderKind kind, uint256 feeRefunded, uint256 collateralRefunded);

    event PositionIncreased(address indexed account, bytes32 indexed gpuId, bool isLong, uint256 newSizeUsd, uint256 newCollateral, uint256 newEntryPrice, uint128 fundingFeeCheckpoint, uint128 fundingCreditCheckpoint, uint128 borrowCheckpoint);
    event PositionDecreased(address indexed account, bytes32 indexed gpuId, bool isLong, uint256 sizeDeltaUsd, int256 realizedPnl, int256 fundingNet, uint256 closeFee, uint256 claimableDelta, uint256 remainingSizeUsd, uint256 remainingCollateral, uint128 fundingFeeCheckpoint, uint128 fundingCreditCheckpoint, uint128 borrowCheckpoint);
    event PositionClosed(address indexed account, bytes32 indexed gpuId, bool isLong, uint256 execPrice);
    event PositionLiquidated(address indexed account, bytes32 indexed gpuId, bool isLong, address indexed executor, uint256 execPrice, uint256 liquidationFee, uint256 badDebt, uint256 claimableDelta);

    event ClaimableSettled(address indexed account, bytes32 indexed gpuId, uint256 amount);
    event Claimed(address indexed account, address indexed to, uint256 requested, uint256 paid);
    event FundingAccrued(bytes32 indexed gpuId, uint128 chargePerUnitLong, uint128 chargePerUnitShort, uint128 creditPerUnitLong, uint128 creditPerUnitShort, uint128 borrowPerUnit, uint64 updatedAt);

    // ------------------------------------------------------------- errors

    error ZeroAddress();
    error ZeroAmount();
    error MarketAlreadyExists(bytes32 gpuId);
    error UnknownMarket(bytes32 gpuId);
    error MarketDisabled(bytes32 gpuId);
    error InvalidMarketParams(bytes32 gpuId);
    error ZeroTriggerPrice();
    error ZeroAcceptablePrice();
    error UnexpectedTriggerPrice(); // market-order field that must be zero
    error UnexpectedAcceptablePrice(); // trigger-order field that must be zero
    error UnknownOrder(uint256 orderId);
    error OrderNotPending(uint256 orderId, OrderStatus status);
    error OrderDelayPending(uint256 orderId, uint64 readyAt);
    error OrderDelayTooHigh(uint256 requested, uint256 cap);
    error NotOrderAccount(address caller, address account);
    error NoPosition(address account, bytes32 gpuId, bool isLong);
    error PositionTooLarge(uint256 requested, uint256 cap);
    error BelowMinCollateral(uint256 collateral, uint256 min);
    error LeverageTooHigh(uint256 leverageBps, uint256 maxBps);
    error MaxOiExceeded(uint256 requested, uint256 cap);
    error ExecutionFeeTooLow(uint256 fee, uint256 min);
    error SizeExceedsPosition(uint256 requested, uint256 size);
    error UnacceptablePrice(uint256 price, uint128 bound, bool requireAtMost);
    error TriggerNotMet(OrderKind kind, bool isLong, uint256 price, uint128 trigger);
    error NotLiquidatable(int256 equity, uint256 maintenance);
    error NothingToClaim();

    // ------------------------------------------------------------ storage

    function gUSD() external view returns (IERC20);
    function sgusd() external view returns (ISgUSD);
    function oracle() external view returns (IGpuOracle);
    function revenueLedger() external view returns (address);

    function markets(bytes32 gpuId) external view returns (Market memory);
    function marketExists(bytes32 gpuId) external view returns (bool);
    function orders(uint256 orderId) external view returns (Order memory);
    function positions(address account, bytes32 gpuId, bool isLong) external view returns (Position memory);
    function claimableOf(address account) external view returns (uint256);
    function totalClaimable() external view returns (uint256);
    function reservedPnl() external view returns (uint256);
    function minOrderDelay() external view returns (uint32);
    function orderNonce() external view returns (uint256);
    function activeTrigger(address account, bytes32 gpuId, bool isLong, uint8 kind) external view returns (uint256 orderId);

    // -------------------------------------------------------------- admin

    function createMarket(bytes32 gpuId, MarketParams calldata params) external;
    function setMarketParams(bytes32 gpuId, MarketParams calldata params) external;
    function setMarketEnabled(bytes32 gpuId, bool enabled) external;
    function setMinOrderDelay(uint32 seconds_) external;
    function pause() external;
    function unpause() external;

    // -------------------------------------------------------------- users

    /// @notice Creates an order, locking its collateral + execution fee.
    function createOrder(OrderParams calldata params) external returns (uint256 orderId);

    /// @notice Cancels a pending order (account only, exempt from the
    ///         execution delay): refunds the locked execution fee — and the
    ///         locked collateral for increase orders — to the account.
    function cancelOrder(uint256 orderId) external;

    /// @notice Pays out up to `amount` of the caller's settled claimable gUSD
    ///         balance from the sgUSD vault. Partial payment is the designed
    ///         liquidity-crunch behavior: the unclaimed remainder stays
    ///         claimable.
    function claim(uint256 amount, address to) external returns (uint256 paid);

    // ---------------------------------------------------------- execution

    /// @notice Executes a pending order at the report price. Permissionless
    ///         after `minOrderDelay`; the executor receives the escrowed fee.
    ///         Unexecutable conditions (acceptable price, trigger) revert with
    ///         no state change — the order stays armed for a later epoch.
    function executeOrder(uint256 orderId, bytes calldata updateData) external;

    /// @notice Liquidates an underwater position at the report price.
    ///         Permissionless with a fresh attestation; the executor receives
    ///         the liquidation fee, the trader's floored equity becomes
    ///         claimable, the remainder is absorbed by the vault.
    function liquidate(address account, bytes32 gpuId, bool isLong, bytes calldata updateData) external;

    // -------------------------------------------------------------- views

    /// @notice Execution-identical probe: VERIFIES the exact report execution
    ///         would accept (never consumes). Keeper/UI decision input; the
    ///         funding view excludes time since the last on-chain accrual.
    function getPosition(address account, bytes32 gpuId, bool isLong, bytes calldata updateData)
        external
        view
        returns (PositionView memory);

    /// @notice Whether a position is liquidatable at the verified report price.
    function liquidatableAt(address account, bytes32 gpuId, bool isLong, bytes calldata updateData)
        external
        view
        returns (bool);

    function getMarket(bytes32 gpuId) external view returns (MarketView memory);
}