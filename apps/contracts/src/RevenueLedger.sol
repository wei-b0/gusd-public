// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title RevenueLedger — the single gUSD revenue sink.
/// @notice All protocol revenue sources (gUSD mint/redeem fees, issuance fees,
///         v4 pool protocol fees) deliver gUSD here. Anyone may call
///         {distribute}, which splits the entire balance between the sgUSD
///         staking vault and the treasury according to `sgUSDBps`.
/// @dev Deliberately stateless about sources: emitting contracts record their
///      own events; this contract only counts what it has paid out.
contract RevenueLedger is Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice The revenue asset (immutable gUSD).
    IERC20 public immutable gUSD;

    /// @notice sgUSD staking vault receiving the vault share of revenue.
    address public vault;
    /// @notice Treasury receiving the remainder.
    address public treasury;
    /// @notice Share of each distribution to the vault, in basis points (≤ 10_000).
    uint16 public sgUSDBps;

    uint256 public totalToVault;
    uint256 public totalToTreasury;

    error NothingToDistribute();
    error SplitTooLarge();
    error ZeroAddress();

    event Distributed(uint256 amount, uint256 toVault, uint256 toTreasury);
    event RecipientsUpdated(address vault, address treasury);
    event SplitUpdated(uint16 sgUSDBps);

    constructor(IERC20 gUSD_, address initialOwner) Ownable(initialOwner) {
        gUSD = gUSD_;
        sgUSDBps = 5_000; // provisional 50/50
    }

    function setVault(address vault_) external onlyOwner {
        if (vault_ == address(0)) revert ZeroAddress();
        vault = vault_;
        emit RecipientsUpdated(vault_, treasury);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit RecipientsUpdated(vault, treasury_);
    }

    function setSplit(uint16 sgUSDBps_) external onlyOwner {
        if (sgUSDBps_ > 10_000) revert SplitTooLarge();
        sgUSDBps = sgUSDBps_;
        emit SplitUpdated(sgUSDBps_);
    }

    /// @notice Distributes the full gUSD balance to vault + treasury.
    function distribute() external {
        uint256 amt = IERC20(gUSD).balanceOf(address(this));
        if (amt == 0) revert NothingToDistribute();
        uint256 toVault = Math.mulDiv(amt, sgUSDBps, 10_000); // floor
        uint256 toTreasury = amt - toVault; // remainder: no dust lost
        totalToVault += toVault;
        totalToTreasury += toTreasury;
        IERC20(gUSD).safeTransfer(vault, toVault);
        IERC20(gUSD).safeTransfer(treasury, toTreasury);
        emit Distributed(amt, toVault, toTreasury);
    }

    /// @notice gUSD sitting in the ledger awaiting distribution.
    function pendingRevenue() external view returns (uint256) {
        return IERC20(gUSD).balanceOf(address(this));
    }
}
