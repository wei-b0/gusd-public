// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title sgUSD — staked gUSD, the protocol's yield-bearing receipt.
/// @notice An ERC-4626 vault over gUSD. Revenue reaches stakers by a plain
///         gUSD transfer into this vault from {RevenueLedger} — no deposit
///         call, no shares minted to the protocol — so `totalAssets()`
///         (balance-based) rises and the share price appreciates.
/// @dev One-way owner `seed()` gate: no shares can exist before the owner
///      seeds the vault with real gUSD, which structurally blocks the
///      first-depositor share-inflation attack at genesis.
contract sgUSD is ERC4626, Ownable2Step {
    bool private _seeded;

    error NotSeeded();
    error ZeroShares();
    error AlreadySeeded();
    error DecimalsMismatch();

    event Seeded(uint256 assets);

    constructor(IERC20 gusd, address initialOwner)
        ERC4626(gusd)
        ERC20("Staked Gigawatt Dollar", "sgUSD")
        Ownable(initialOwner)
    {
        if (IERC20Metadata(address(gusd)).decimals() != 6) {
            revert DecimalsMismatch();
        }
    }

    /// @notice One-way genesis gate: owner deposits `assets` gUSD at 1:1.
    function seed(uint256 assets) external onlyOwner {
        if (_seeded) revert AlreadySeeded();
        if (assets == 0) revert ZeroShares();
        _seeded = true;
        _deposit(msg.sender, address(this), assets, assets);
        emit Seeded(assets);
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        if (!_seeded) revert NotSeeded();
        super._deposit(caller, receiver, assets, shares);
    }

    function seeded() external view returns (bool) {
        return _seeded;
    }

    /// @notice 6-dec shares to match the 6-dec asset (1:1 genesis).
    function _decimalsOffset() internal pure override returns (uint8) {
        return 0;
    }
}
