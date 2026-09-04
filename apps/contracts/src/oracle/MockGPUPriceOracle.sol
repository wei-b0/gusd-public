// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IGPUPriceOracle} from "./IGPUPriceOracle.sol";

/// @title MockGPUPriceOracle
/// @notice Test/demo oracle. Deliberately permits future timestamps so tests
///         can exercise the consumer's OracleFutureTimestamp check. The real
///         oracle (built by the oracle agent) replaces this at deploy time.
contract MockGPUPriceOracle is IGPUPriceOracle, Ownable2Step {
    uint256 public constant PRICE_SCALE = 10_000;

    mapping(bytes32 => uint256) private _price;
    mapping(bytes32 => uint256) private _updatedAt;

    event PriceSet(bytes32 indexed gpuId, uint256 price, uint256 updatedAt);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setPrice(bytes32 gpuId, uint256 price, uint256 updatedAt) external onlyOwner {
        _price[gpuId] = price;
        _updatedAt[gpuId] = updatedAt;
        emit PriceSet(gpuId, price, updatedAt);
    }

    function getPrice(bytes32 gpuId) external view returns (uint256 price, uint256 updatedAt) {
        return (_price[gpuId], _updatedAt[gpuId]);
    }
}
