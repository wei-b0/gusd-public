// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {MockGPUPriceOracle} from "../src/oracle/MockGPUPriceOracle.sol";

/// @notice Dev utility: deploy the owner-gated MockGPUPriceOracle standalone so
///         its address can be passed to Deploy.s.sol as `ORACLE` (the external-
///         oracle mode where prices arrive through their own publication path).
contract DeployMockOracle is Script {
    function run() external returns (address mock) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        mock = address(new MockGPUPriceOracle(vm.addr(pk)));
        vm.stopBroadcast();
        console2.log("MockGPUPriceOracle", mock);
    }
}
