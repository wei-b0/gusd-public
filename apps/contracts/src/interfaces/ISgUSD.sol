// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Narrow perp surface of sgUSD consumed by {GpuPerpEngine}. sgUSD
///         remains a plain ERC-4626 vault over gUSD (revenue distribution,
///         unlocked ordinary deposits and the genesis seed gate unchanged);
///         these functions add the engine authorization and the perp
///         liability reservation (see PROTOCOL.md, perp section).
interface ISgUSD {
    /// @notice Engine is not the authorized perp engine.
    error NotPerpEngine();
    /// @notice A redemption would dip into gUSD reserved for perp liabilities.
    error PerpReservationShortfall(uint256 available, uint256 requested);

    event PerpEngineSet(address indexed engine);
    event PerpReservedUpdated(uint256 reserved);
    event EngineWithdrawal(address indexed to, uint256 requested, uint256 paid);
    event EngineWithdrawalCapSet(uint256 cap);

    /// @notice Authorizes (or, with zero, detaches) the perp engine. Owner only.
    function setPerpEngine(address engine) external;

    /// @notice Sets the engine's maximum gUSD payout per block. Owner only.
    function setEngineMaxWithdrawPerBlock(uint256 cap) external;

    /// @notice The engine pushes `totalClaimable + reservedPnl` after every
    ///         mutation. Ordinary redemptions cannot dip below this reserve.
    function setPerpReserved(uint256 reserved) external;

    /// @notice Pays a settled claim out of vault liquidity:
    ///         `min(amount, balance, per-block cap room)` — every limit clamps,
    ///         nothing reverts (partial payment is the designed liquidity-crunch
    ///         behavior). The claimant's counter keeps the remainder claimable.
    ///         Engine only.
    function perpWithdraw(address to, uint256 amount) external returns (uint256 paid);

    function perpEngine() external view returns (address);
    function perpReserved() external view returns (uint256);
    function engineMaxWithdrawPerBlock() external view returns (uint256);
}