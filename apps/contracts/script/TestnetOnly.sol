// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Mainnet predicate + guard for the deploy tooling. Testnet-only
///         recipes (mock tokens, demo actor keys, seeded activity) must
///         never reach a production chain; the production Deploy uses the
///         predicate to refuse its own mock postures there. The live path
///         is script/Deploy.s.sol run with real assets via env: UNDERLYING,
///         PUBLISHER, TREASURY, STABLES and the SEED_PRICE_* launch prices
///         (see docs/mainnet-deploy.md).
abstract contract TestnetOnly {
    /// @dev Chain ids the product registry treats as production mainnets,
    ///     plus the majors so an accidental `--rpc-url` at an unrelated
    ///     mainnet is caught too. Extend as the registry grows.
    function _isMainnet() internal view returns (bool) {
        uint256 id = block.chainid;
        return id == 4663 // Robinhood Chain mainnet
            || id == 8453 // Base mainnet
            || id == 1; // Ethereum mainnet
    }

    /// @dev The testnet-only recipes revert before their first broadcast.
    function _refuseOnMainnet() internal view {
        require(!_isMainnet(), "testnet-only recipe: no mock deployments on mainnet");
    }
}
