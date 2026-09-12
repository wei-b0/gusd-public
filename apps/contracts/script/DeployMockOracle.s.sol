// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {MockGPUPriceOracle} from "../src/oracle/MockGPUPriceOracle.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// @notice Dev utility: deploy the owner-gated MockGPUPriceOracle standalone so
///         its address can be passed to Deploy.s.sol as `ORACLE` (the external-
///         oracle mode where prices arrive through their own publication path).
///         REFUSES mainnets (TestnetOnly) — a mock oracle is never a
///         production deployment.
contract DeployMockOracle is Script, TestnetOnly {
    function run() external returns (address mock) {
        _refuseOnMainnet();
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        mock = address(new MockGPUPriceOracle(vm.addr(pk)));
        vm.stopBroadcast();
        console2.log("MockGPUPriceOracle", mock);
    }
}
