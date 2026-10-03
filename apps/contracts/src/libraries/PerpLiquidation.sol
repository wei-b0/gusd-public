// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IGpuOracle} from "../oracle/IGpuOracle.sol";
import {ReportCodec} from "../oracle/ReportCodec.sol";
import {IGpuPerpEngine} from "../interfaces/IGpuPerpEngine.sol";
import {ISgUSD} from "../interfaces/ISgUSD.sol";
import {PerpMath} from "./PerpMath.sol";
import {PerpFunding} from "./PerpFunding.sol";

/// @title PerpLiquidation
/// @notice Deployed execution library for `GpuPerpEngine` (the EIP-170 split).
///         The engine delegatecalls into it for liquidation, keeping the
///         engine's runtime bytecode under the 24,576-byte limit. Storage
///         pointers are passed by slot — every byte of state still lives in
///         (and is only ever mutated through) the engine's own storage, and
///         under delegatecall `msg.sender`/`address(this)` are the engine's
///         caller and the engine itself, so event attribution and the sgUSD
///         `onlyPerpEngine` authorization are unchanged.
library PerpLiquidation {
    using SafeERC20 for IERC20;

    /// @notice Permissionless liquidation — allowed while paused (it reduces
    ///         protocol risk). Full close only. Mirrors the decrease money
    ///         flow: liquidation fee to the executor, the positive remainder
    ///         (if any) to `claimableOf`, bad debt to the sgUSD vault.
    function liquidate(
        mapping(bytes32 => IGpuPerpEngine.Market) storage _markets,
        mapping(bytes32 => bool) storage _marketExists,
        mapping(bytes32 => IGpuPerpEngine.Position) storage _positions,
        mapping(address => uint256) storage claimableOf,
        IGpuPerpEngine.Totals storage totals,
        IERC20 gUSD,
        ISgUSD sgusd,
        IGpuOracle oracle,
        address revenueLedger,
        address account,
        bytes32 gpuId,
        bool isLong,
        bytes calldata updateData
    ) external {
        if (!_marketExists[gpuId]) revert IGpuPerpEngine.UnknownMarket(gpuId);
        IGpuPerpEngine.Market storage m = _markets[gpuId];
        bytes32 pk = _positionKey(account, gpuId, isLong);
        IGpuPerpEngine.Position storage pos = _positions[pk];
        if (pos.sizeUsd == 0) revert IGpuPerpEngine.NoPosition(account, gpuId, isLong);
        (IGpuOracle.Report calldata report, bytes calldata signature) = ReportCodec.decode(updateData);
        uint256 price = oracle.consume(gpuId, report, signature);
        PerpFunding.accrue(m, gpuId, uint64(block.timestamp));
        PerpFunding.Settlement memory s = PerpFunding.settle(m, pos, isLong);

        int256 uPnl = PerpMath.pnl(pos.sizeUsd, pos.entryPrice, isLong, price);
        uint256 debts = s.owed + s.borrow;
        // The whole earned state — carried balance + this settlement's
        // un-accrued credit — folds into the settlement: same shape as the
        // decrease path (GpuPerpEngine._executeDecrease). Equity = collateral
        // + uPnL + earned funding − debts. Excluding the earned funding
        // would forfeit a receiver-side position's credits at liquidation
        // AND understate the gate's equity.
        uint256 balanceTotal = uint256(pos.earnedFunding) + s.earned;
        int256 equity = int256(uint256(pos.collateral)) + uPnl + int256(balanceTotal) - int256(debts);
        uint256 maintenance = PerpMath.maintenance(pos.sizeUsd, m.params.maintenanceMarginBps);
        if (equity >= int256(maintenance)) revert IGpuPerpEngine.NotLiquidatable(equity, maintenance);

        uint256 liqFee = PerpMath.feeBps(pos.sizeUsd, m.params.liquidationFeeBps);
        if (liqFee > pos.collateral) liqFee = pos.collateral;
        int256 net = equity - int256(liqFee);
        uint256 due = net > 0 ? uint256(net) : 0;
        if (due > 0) {
            claimableOf[account] += due;
            totals.totalClaimable += due;
            emit IGpuPerpEngine.ClaimableSettled(account, gpuId, due);
        }
        if (liqFee > 0) gUSD.safeTransfer(msg.sender, liqFee);
        // The whole non-fee remainder goes to the vault; `due` is the vault's
        // liability (paid at claim), so its net is `coll − liqFee − due` —
        // the absorbed loss + bad debt. Same shape as the decrease flow.
        uint256 toVault = uint256(pos.collateral) > liqFee ? uint256(pos.collateral) - liqFee : 0;
        if (toVault > 0) gUSD.safeTransfer(address(sgusd), toVault);
        uint256 badDebt = liqFee + due > pos.collateral ? liqFee + due - pos.collateral : 0;

        if (isLong) {
            m.openNotionalLong -= pos.sizeUsd;
        } else {
            m.openNotionalShort -= pos.sizeUsd;
        }
        totals.reservedPnl -= pos.reserveShare;
        // The accumulator tracks Σ carried balances — the un-accrued
        // `s.earned` share of balanceTotal was never added to it (only
        // touch-folded earned is), so it must not be subtracted either.
        totals.totalEarnedFunding -= pos.earnedFunding;
        delete _positions[pk];
        sgusd.setPerpReserved(totals.totalClaimable + totals.reservedPnl + totals.totalEarnedFunding);
        emit IGpuPerpEngine.PositionLiquidated(account, gpuId, isLong, msg.sender, price, liqFee, badDebt, due);
    }

    function _positionKey(address account, bytes32 gpuId, bool isLong) internal pure returns (bytes32) {
        return keccak256(abi.encode(account, gpuId, isLong));
    }
}