// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {GpuId} from "../libraries/GpuId.sol";
import {IGPUPriceOracle} from "./IGPUPriceOracle.sol";

/// @title GPUPriceOracle
/// @notice Production oracle for the canonical offchain GPU index. The offchain
///         publisher (`apps/publisher` with `PUBLISHER_TARGET=chain`) signs and
///         submits `publish`; the owner is an escape hatch for genesis seeding
///         and incident response, not the routine price writer.
/// @dev Encoding contract (see IGPUPriceOracle): `price` is USD per GPU-hour in
///      4-decimal fixed point (real price x PRICE_SCALE = 10_000); `gpuId` is
///      the canonical bytes32 SKU (see src/libraries/GpuId.sol); `updatedAt` is
///      unix seconds of the observation. Writes clamp `updatedAt` to
///      `block.timestamp` — the chain clock lags the publisher clock, and
///      consumers (GPUIssuance) revert on future timestamps — so the real
///      oracle can never hand a consumer a future `updatedAt`.
contract GPUPriceOracle is IGPUPriceOracle, Ownable2Step {
    uint256 public constant PRICE_SCALE = 10_000;

    address public publisher;
    address public pendingPublisher;

    /// @notice Per-publish deviation bound in bps vs the last published price
    ///         for the same GPU: defense-in-depth against a compromised
    ///         publisher key, NOT the publication trigger policy (the 0.5%
    ///         deviation publication of PROTOCOL.md §11 is an offchain
    ///         decision). 0 = disabled (deploy default).
    uint16 public maxDeviationBps;

    mapping(bytes32 => uint256) private _price;
    mapping(bytes32 => uint256) private _updatedAt;

    /// @notice `publish` called by anyone but the current publisher.
    error NotPublisher();
    /// @notice `acceptPublisher` called by an address other than the pending one.
    error NotPendingPublisher();
    /// @notice A zero price was submitted (0 means "unknown" and is never publishable).
    error InvalidPrice();
    /// @notice The zero address cannot become (or be set as) the publisher.
    error ZeroPublisher();
    /// @notice A publish moved the price further than `maxBps` from `previousPrice`.
    error DeviationExceeded(uint256 previousPrice, uint256 newPrice, uint16 maxBps);

    event PricePublished(bytes32 indexed gpuId, uint256 price, uint256 updatedAt, uint256 previousPrice);
    event PriceOverridden(bytes32 indexed gpuId, uint256 price, uint256 updatedAt);
    event PublisherTransferStarted(address indexed currentPublisher, address indexed nextPublisher);
    event PublisherAccepted(address indexed previousPublisher, address indexed newPublisher);
    event MaxDeviationBpsSet(uint16 bps);

    constructor(address initialOwner, address publisher_, uint16 maxDeviationBps_) Ownable(initialOwner) {
        if (publisher_ == address(0)) revert ZeroPublisher();
        publisher = publisher_;
        maxDeviationBps = maxDeviationBps_;
    }

    /// @notice Routine write path: the automated offchain publisher only.
    function publish(bytes32 gpuId, uint256 price, uint256 updatedAt) external {
        if (msg.sender != publisher) revert NotPublisher();
        (uint256 ts, uint256 prev) = _write(gpuId, price, updatedAt, true);
        emit PricePublished(gpuId, price, ts, prev);
    }

    /// @notice Owner escape hatch for genesis seeding and incident response
    ///         (dead/compromised publisher key). Deliberately bypasses the
    ///         deviation bound — an override must be able to cross any gap —
    ///         and resets the baseline by writing.
    function setPriceOverride(bytes32 gpuId, uint256 price, uint256 updatedAt) external onlyOwner {
        (uint256 ts,) = _write(gpuId, price, updatedAt, false);
        emit PriceOverridden(gpuId, price, ts);
    }

    /// @notice Starts 2-step publisher rotation (mirrors Ownable2Step).
    function transferPublisher(address next) external onlyOwner {
        if (next == address(0)) revert ZeroPublisher();
        pendingPublisher = next;
        emit PublisherTransferStarted(publisher, next);
    }

    /// @notice The pending publisher accepts the role.
    function acceptPublisher() external {
        if (msg.sender != pendingPublisher) revert NotPendingPublisher();
        address previous = publisher;
        publisher = msg.sender;
        pendingPublisher = address(0);
        emit PublisherAccepted(previous, msg.sender);
    }

    /// @notice Sets the per-publish deviation bound (0 = disabled).
    function setMaxDeviationBps(uint16 bps) external onlyOwner {
        maxDeviationBps = bps;
        emit MaxDeviationBpsSet(bps);
    }

    /// @inheritdoc IGPUPriceOracle
    function getPrice(bytes32 gpuId) external view returns (uint256 price, uint256 updatedAt) {
        return (_price[gpuId], _updatedAt[gpuId]);
    }

    /// @dev Shared write validation. `checkDeviation` is false for the owner
    ///      hatch. The deviation check is skipped when disabled (0) or when no
    ///      price exists yet (first publish for a GPU cannot deviate).
    function _write(bytes32 gpuId, uint256 price, uint256 updatedAt, bool checkDeviation)
        internal
        returns (uint256 ts, uint256 prev)
    {
        GpuId.validate(gpuId);
        if (price == 0) revert InvalidPrice();
        prev = _price[gpuId];
        if (checkDeviation && maxDeviationBps != 0 && prev != 0) {
            uint256 delta = price > prev ? price - prev : prev - price;
            // Floor division with "exceeds" semantics: a move exactly at the
            // bound passes, anything whose scaled delta floors above it reverts.
            if (Math.mulDiv(delta, 10_000, prev) > maxDeviationBps) {
                revert DeviationExceeded(prev, price, maxDeviationBps);
            }
        }
        ts = updatedAt > block.timestamp ? block.timestamp : updatedAt;
        _price[gpuId] = price;
        _updatedAt[gpuId] = ts;
    }
}
