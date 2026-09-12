// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {TestnetOnly} from "../../script/TestnetOnly.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {DeployFull} from "../../script/Deploy.full.s.sol";
import {Demo} from "../../script/Demo.s.sol";
import {IndexerDemo} from "../../script/IndexerDemo.s.sol";
import {DeployMockOracle} from "../../script/DeployMockOracle.s.sol";

/// @notice The deploy tooling's mainnet posture, enforced at the source:
///         every mock/demo recipe reverts on a production chain before its
///         first broadcast, and the production Deploy refuses its dev
///         postures (mock reserve, fixture seeds) there. Real-money
///         deploys ride the production Deploy with real assets — see
///         docs/mainnet-deploy.md.
contract Refuser is TestnetOnly {
    function refuse() external view {
        _refuseOnMainnet();
    }
}

contract TestnetOnlyTest is Test {
    uint256[] internal MAINNETS = [uint256(4663), 8453, 1];
    uint256[] internal TESTNETS = [uint256(31337), 46_630, 84_532];

    // Creations are hoisted out of every expectRevert window: the CREATE
    // itself is the "next call" to a freshly-set expectation, and a
    // successful creation would consume it before the reverting method runs.
    Refuser internal refuser;
    Deploy internal deploy;
    DeployFull internal deployFull;
    Demo internal demo;
    IndexerDemo internal indexerDemo;
    DeployMockOracle internal mockOracle;

    constructor() {
        refuser = new Refuser();
        deploy = new Deploy();
        deployFull = new DeployFull();
        demo = new Demo();
        indexerDemo = new IndexerDemo();
        mockOracle = new DeployMockOracle();
    }

    function _revertErr(string memory message) private pure returns (bytes memory) {
        return abi.encodeWithSignature("Error(string)", message);
    }

    function test_refuseOnMainnet_reverts_on_every_production_chain() external {
        for (uint256 i; i < MAINNETS.length; ++i) {
            vm.chainId(MAINNETS[i]);
            vm.expectRevert(_revertErr("testnet-only recipe: no mock deployments on mainnet"));
            refuser.refuse();
        }
    }

    function test_refuseOnMainnet_passes_on_testnets() external {
        for (uint256 i; i < TESTNETS.length; ++i) {
            vm.chainId(TESTNETS[i]);
            refuser.refuse();
        }
    }

    function test_testnet_recipes_refuse_mainnet() external {
        // The guards fire before any environment read, so no key staging.
        vm.chainId(4663);
        bytes memory err = _revertErr("testnet-only recipe: no mock deployments on mainnet");
        vm.expectRevert(err);
        deployFull.runFull();
        vm.expectRevert(err);
        demo.run();
        vm.expectRevert(err);
        indexerDemo.run();
        vm.expectRevert(err);
        mockOracle.run();
    }

    // One test, one thread: forge tests run in parallel threads sharing the
    // process environment, so env-staged postures must be walked in a single
    // test to stay deterministic. Empty string = unset (envOr falls back to
    // the default, which for these inputs is exactly "not provided").
    function test_deploy_mainnet_posture() external {
        _setKey();
        _unsetPosture();
        vm.chainId(4663);
        // No real reserve staged: the mock-reserve posture is refused.
        vm.expectRevert(_revertErr("mainnet requires a real UNDERLYING (no mock reserve on mainnet)"));
        deploy.run();
        // With a real reserve staged, the first missing seed is the loud
        // failure — no broadcast ever starts.
        vm.setEnv("UNDERLYING", "0xe343167631d89B6Ffc58B88d6b7fB0228795491D");
        vm.expectRevert(_revertErr("mainnet requires SEED_PRICE_H100"));
        deploy.run();
        vm.setEnv("SEED_PRICE_H100", "25000");
        vm.expectRevert(_revertErr("mainnet requires SEED_PRICE_H200"));
        deploy.run();
    }

    function _setKey() private {
        vm.setEnv(
            "PRIVATE_KEY",
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
        );
    }

    /// @dev The dev posture, staged absent: empty string falls back to the
    ///     envOr defaults, which for these inputs is exactly "not provided".
    function _unsetPosture() private {
        vm.setEnv("UNDERLYING", "");
        vm.setEnv("SEED_PRICE_H100", "");
        vm.setEnv("SEED_PRICE_H200", "");
        vm.setEnv("SEED_PRICE_L40S", "");
        vm.setEnv("SEED_PRICE_RTX4090", "");
    }
}
