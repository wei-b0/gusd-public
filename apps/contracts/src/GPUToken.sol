// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title GPUToken — ERC-20 claim on one GPU-hour SKU.
/// @notice One token per GPU SKU (e.g. "H100_SXM_80GB"). Supply changes ONLY
///         through the immutable `issuer` (GPUIssuance), which mints strictly
///         against gUSD paid at the oracle price. Burn exists for the future
///         buyback mechanism (PROTOCOL.md §14) but is unused in V1.
contract GPUToken is ERC20 {
    /// @notice The only address allowed to mint/burn.
    address public immutable issuer;
    /// @notice Canonical GPU ID (left-aligned ASCII bytes32).
    bytes32 public immutable gpuId;

    error OnlyIssuer();

    constructor(address issuer_, bytes32 gpuId_, string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        issuer = issuer_;
        gpuId = gpuId_;
    }

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert OnlyIssuer();
        _;
    }

    function mint(address to, uint256 amount) external onlyIssuer {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyIssuer {
        _burn(from, amount);
    }
}
