// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IGpuOracle} from "../oracle/IGpuOracle.sol";
import {ReportCodec} from "../oracle/ReportCodec.sol";
import {IGpuPerpEngine} from "../interfaces/IGpuPerpEngine.sol";
import {PerpMath} from "./PerpMath.sol";

/// @title PerpViews
/// @notice Deployed view library for `GpuPerpEngine` (the EIP-170 split): the
///         engine delegatecalls into it for the report-consuming probes and
///         the market view, keeping the engine's runtime bytecode under the
///         24,576-byte limit. Storage pointers are passed by slot — state
///         lives in, and is owned by, the engine; these functions only read.
library PerpViews {
    using Math for uint256;

    /// @notice Execution-identical probe: VERIFIES the exact report execution
    ///         would accept (never consumes). The funding view is computed
    ///         against the on-chain cumulatives WITHOUT advancing them, so it
    ///         excludes the time since the last accrual — a display/probe
    ///         approximation; `liquidate`/`executeOrder` are authoritative.
    function getPosition(
        mapping(bytes32 => IGpuPerpEngine.Market) storage _markets,
        mapping(bytes32 => bool) storage _marketExists,
        mapping(bytes32 => IGpuPerpEngine.Position) storage _positions,
        IGpuOracle oracle,
        address account,
        bytes32 gpuId,
        bool isLong,
        bytes calldata updateData
    ) external view returns (IGpuPerpEngine.PositionView memory v) {
        if (!_marketExists[gpuId]) revert IGpuPerpEngine.UnknownMarket(gpuId);
        (IGpuOracle.Report calldata report, bytes calldata signature) = ReportCodec.decode(updateData);
        uint256 price = oracle.verify(gpuId, report, signature);
        IGpuPerpEngine.Market storage m = _markets[gpuId];
        IGpuPerpEngine.Position storage pos = _positions[_positionKey(account, gpuId, isLong)];
        v.position = pos;
        int256 uPnl = PerpMath.pnl(pos.sizeUsd, pos.entryPrice, isLong, price);
        uint128 feeCum = isLong ? m.fundingChargePerUnitLong : m.fundingChargePerUnitShort;
        uint128 creditCum = isLong ? m.fundingCreditPerUnitLong : m.fundingCreditPerUnitShort;
        uint256 owed = PerpMath.fundingOwed(pos.sizeUsd, feeCum, pos.fundingFeeCheckpoint);
        uint256 earned = PerpMath.fundingEarned(pos.sizeUsd, creditCum, pos.fundingCreditCheckpoint);
        uint256 borrow = PerpMath.fundingOwed(pos.sizeUsd, m.borrowChargePerUnit, pos.borrowCheckpoint);
        v.uPnL = uPnl;
        v.fundingDue = int256(earned) - int256(owed + borrow);
        // Same equity shape as the decrease/liquidation paths: collateral +
        // uPnL + accrued funding credits − debts — the gate's own figure.
        v.equity = int256(uint256(pos.collateral)) + uPnl + v.fundingDue;
        v.maintenance = PerpMath.maintenance(pos.sizeUsd, m.params.maintenanceMarginBps);
        v.liquidatable = pos.sizeUsd > 0 && v.equity < int256(v.maintenance);
    }

    /// @notice Whether the position would be liquidatable at the report's
    ///         price (verify-only probe; `liquidate` is authoritative).
    function liquidatableAt(
        mapping(bytes32 => IGpuPerpEngine.Market) storage _markets,
        mapping(bytes32 => bool) storage _marketExists,
        mapping(bytes32 => IGpuPerpEngine.Position) storage _positions,
        IGpuOracle oracle,
        address account,
        bytes32 gpuId,
        bool isLong,
        bytes calldata updateData
    ) external view returns (bool) {
        if (!_marketExists[gpuId]) revert IGpuPerpEngine.UnknownMarket(gpuId);
        (IGpuOracle.Report calldata report, bytes calldata signature) = ReportCodec.decode(updateData);
        uint256 price = oracle.verify(gpuId, report, signature);
        IGpuPerpEngine.Market storage m = _markets[gpuId];
        IGpuPerpEngine.Position storage pos = _positions[_positionKey(account, gpuId, isLong)];
        if (pos.sizeUsd == 0) return false;
        return _equityOf(m, pos, isLong, price)
            < int256(PerpMath.maintenance(pos.sizeUsd, m.params.maintenanceMarginBps));
    }

    /// @notice Market state with pro-forma funding rates: what each side
    ///         would pay/earn per second at the CURRENT open interest.
    function getMarket(
        mapping(bytes32 => IGpuPerpEngine.Market) storage _markets,
        mapping(bytes32 => bool) storage _marketExists,
        bytes32 gpuId
    ) external view returns (IGpuPerpEngine.MarketView memory v) {
        if (!_marketExists[gpuId]) revert IGpuPerpEngine.UnknownMarket(gpuId);
        IGpuPerpEngine.Market storage m = _markets[gpuId];
        v.market = m;
        v.fundingRateLongPpmPerSec =
            PerpMath.proFormaRate(m.params.fundingRatePpmPerSec, m.openNotionalLong, m.openNotionalShort, true);
        v.fundingRateShortPpmPerSec =
            PerpMath.proFormaRate(m.params.fundingRatePpmPerSec, m.openNotionalLong, m.openNotionalShort, false);
        v.borrowRatePpmPerSec = int256(uint256(m.params.borrowRatePpmPerSec));
    }

    /// @dev Equity at `price` including accrued funding — charges AND earned
    ///      credits (the funding view without accruing — see getPosition);
    ///      the exact figure `liquidate`'s gate evaluates.
    function _equityOf(
        IGpuPerpEngine.Market storage m,
        IGpuPerpEngine.Position storage pos,
        bool isLong,
        uint256 price
    ) internal view returns (int256) {
        int256 uPnl = PerpMath.pnl(pos.sizeUsd, pos.entryPrice, isLong, price);
        uint128 feeCum = isLong ? m.fundingChargePerUnitLong : m.fundingChargePerUnitShort;
        uint128 creditCum = isLong ? m.fundingCreditPerUnitLong : m.fundingCreditPerUnitShort;
        uint256 owed = PerpMath.fundingOwed(pos.sizeUsd, feeCum, pos.fundingFeeCheckpoint);
        uint256 earned = PerpMath.fundingEarned(pos.sizeUsd, creditCum, pos.fundingCreditCheckpoint);
        uint256 borrow = PerpMath.fundingOwed(pos.sizeUsd, m.borrowChargePerUnit, pos.borrowCheckpoint);
        return int256(uint256(pos.collateral)) + uPnl + int256(earned) - int256(owed + borrow);
    }

    function _positionKey(address account, bytes32 gpuId, bool isLong) internal pure returns (bytes32) {
        return keccak256(abi.encode(account, gpuId, isLong));
    }
}