// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IGpuOracle} from "./IGpuOracle.sol";

/// @title GpuOracle
/// @notice Pull-oracle verifier/consumer for signed GPU index reports. Replaces
///         the push-based GPUPriceOracle: there is no publisher transaction, no
///         publication threshold, no heartbeat. The attestor signs offchain;
///         the trade caller submits `updateData = abi.encode(Report, signature)`
///         inside the consuming transaction; this contract verifies it and
///         deterministically decides whether it is THE executable report.
/// @dev Acceptance rules (all deterministic — at any instant exactly one epoch
///      is acceptable, so old and future reports are objectively non-executable):
///       1. version == 1
///       2. price != 0
///       3. report.gpuId == the consuming market's gpuId
///       4. report.epoch == block.timestamp / epochLength   (current epoch)
///       5. validFrom == epoch * epochLength, validUntil == validFrom + epochLength
///       6. observedAt <= block.timestamp
///       7. observedAt >= block.timestamp - maxObservationAge
///      The report is signed as EIP-712 over domain {name:"gUSD GPU Oracle",
///      version:"1", chainId, verifyingContract}, so cross-chain and
///      cross-contract replay are rejected by the domain.
///
///      Adversarial report selection: epochs are non-overlapping, so selection
///      across epochs is impossible. Within one epoch, the FIRST consumer
///      binds the epoch to its reportHash; later consumers must present the
///      byte-identical report or revert (first-consumer-wins). An honest
///      attestor signs exactly one report per (gpuId, epoch), so there is
///      nothing to select between; equivocation is on-chain-attributable
///      (PriceConsumed events) and economically pointless.
///
///      lastConsumed* state is OBSERVABILITY ONLY and must never be used as a
///      price input; the executable price is always the report verified in the
///      caller's transaction.
contract GpuOracle is IGpuOracle, EIP712, Ownable2Step {
    bytes32 private constant _REPORT_TYPEHASH =
        keccak256("Report(uint16 version,bytes32 gpuId,uint256 price,uint64 observedAt,uint64 epoch,uint64 validFrom,uint64 validUntil,bytes32 calcHash)");

    /// @dev Transient (per-transaction) verified-report registry seed. Lets a
    ///      transaction verify a report once (hook) and reuse the verdict
    ///      (issuance backstop) without a second ecrecover.
    uint256 private constant _VERIFIED_SEED = uint256(keccak256("gusd.GpuOracle.verified.transient")) - 1;

    uint64 public override epochLength;
    uint64 public override maxObservationAge;

    address public override signer;
    address public override pendingSigner;

    /// @dev Per-GPU observability record of the last consumed report.
    struct ConsumeRecord {
        uint256 price;
        uint64 observedAt;
        uint64 epoch;
        bytes32 reportHash;
    }
    mapping(bytes32 => ConsumeRecord) private _consumed;

    constructor(address initialOwner, address signer_, uint64 epochLength_, uint64 maxObservationAge_)
        Ownable(initialOwner)
        EIP712("gUSD GPU Oracle", "1")
    {
        if (signer_ == address(0)) revert ZeroSigner();
        if (epochLength_ == 0) revert EpochLengthZero();
        if (maxObservationAge_ < epochLength_) revert ObservationAgeBelowEpoch(maxObservationAge_, epochLength_);
        signer = signer_;
        epochLength = epochLength_;
        maxObservationAge = maxObservationAge_;
    }

    /// @inheritdoc IGpuOracle
    function verify(bytes32 gpuId, Report calldata report, bytes calldata signature) external view override returns (uint256) {
        return _verify(gpuId, report, signature);
    }

    /// @inheritdoc IGpuOracle
    function consume(bytes32 gpuId, Report calldata report, bytes calldata signature) external override returns (uint256 price) {
        price = _verify(gpuId, report, signature);
        bytes32 h = reportHash(report, signature);
        _markVerified(h);
        ConsumeRecord storage rec = _consumed[report.gpuId];
        if (rec.epoch == report.epoch) {
            // Same epoch: only the byte-identical report is executable
            // (first-consumer-wins). A different report here is equivocation.
            if (rec.reportHash != h) revert EpochAlreadyBound(rec.reportHash, h);
        } else {
            // First consumption of this epoch (or an admin epochLength change
            // moved the grid): bind and announce.
            rec.price = price;
            rec.observedAt = report.observedAt;
            rec.epoch = report.epoch;
            rec.reportHash = h;
            emit PriceConsumed(report.gpuId, price, report.epoch, report.observedAt, h, msg.sender);
        }
    }

    /// @inheritdoc IGpuOracle
    function reportHash(Report calldata report, bytes calldata signature) public pure override returns (bytes32) {
        return keccak256(abi.encode(report, signature));
    }

    /// @inheritdoc IGpuOracle
    function reportDigest(Report calldata report) public view override returns (bytes32) {
        return _hashTypedDataV4(_reportStructHash(report));
    }

    /// @inheritdoc IGpuOracle
    function currentEpoch() public view override returns (uint64) {
        return uint64(block.timestamp / epochLength);
    }

    /// @notice Starts 2-step signer rotation. Unlike the owner (who tunes
    ///         parameters), only the current signer can hand off signing.
    function transferSigner(address next) external override {
        if (msg.sender != signer) revert NotSigner();
        if (next == address(0)) revert ZeroSigner();
        pendingSigner = next;
        emit SignerTransferStarted(signer, next);
    }

    /// @notice The pending signer accepts the role. Reports signed by the
    ///         previous signer revert from this point on.
    function acceptSigner() external override {
        if (msg.sender != pendingSigner) revert NotPendingSigner();
        address previous = signer;
        signer = msg.sender;
        pendingSigner = address(0);
        emit SignerAccepted(previous, msg.sender);
    }

    function setEpochLength(uint64 seconds_) external onlyOwner override {
        if (seconds_ == 0) revert EpochLengthZero();
        if (maxObservationAge < seconds_) revert ObservationAgeBelowEpoch(maxObservationAge, seconds_);
        epochLength = seconds_;
        emit EpochLengthSet(seconds_);
    }

    function setMaxObservationAge(uint64 seconds_) external onlyOwner override {
        if (seconds_ < epochLength) revert ObservationAgeBelowEpoch(seconds_, epochLength);
        maxObservationAge = seconds_;
        emit MaxObservationAgeSet(seconds_);
    }

    /// @inheritdoc IGpuOracle
    function lastConsumedPrice(bytes32 gpuId) external view override returns (uint256) {
        return _consumed[gpuId].price;
    }

    /// @inheritdoc IGpuOracle
    function lastConsumedAt(bytes32 gpuId) external view override returns (uint64) {
        return _consumed[gpuId].observedAt;
    }

    /// @inheritdoc IGpuOracle
    function lastConsumedEpoch(bytes32 gpuId) external view override returns (uint64) {
        return _consumed[gpuId].epoch;
    }

    /// @inheritdoc IGpuOracle
    function lastConsumedReportHash(bytes32 gpuId) external view override returns (bytes32) {
        return _consumed[gpuId].reportHash;
    }

    /// @dev Full acceptance check. The transient registry short-circuits the
    ///      ecrecover when the byte-identical report was already verified in
    ///      this transaction (hook -> issuance backstop); structural checks
    ///      always run so a stale call reverts regardless.
    function _verify(bytes32 gpuId, Report calldata report, bytes calldata signature) internal view returns (uint256) {
        if (report.version != 1) revert InvalidVersion(report.version);
        if (report.price == 0) revert ZeroPrice();
        if (report.gpuId != gpuId) revert GpuMismatch(gpuId, report.gpuId);
        uint64 epoch = currentEpoch();
        if (report.epoch != epoch) revert UnknownGpuEpoch(epoch, report.epoch);
        uint64 from = report.epoch * epochLength;
        if (report.validFrom != from || report.validUntil != from + epochLength) {
            revert BadEpochBinding(report.validFrom, report.validUntil);
        }
        if (report.observedAt > block.timestamp) revert FutureObservation(report.observedAt, uint64(block.timestamp));
        // observedAt + maxObservationAge >= now (uint256 math: no underflow early in chain time)
        if (uint256(report.observedAt) + maxObservationAge < block.timestamp) {
            uint64 minObservedAt = block.timestamp > maxObservationAge ? uint64(block.timestamp - maxObservationAge) : 0;
            revert StaleObservation(report.observedAt, minObservedAt);
        }
        bytes32 h = reportHash(report, signature);
        if (!_verifiedTransient(h)) {
            address recovered = ECDSA.recoverCalldata(_hashTypedDataV4(_reportStructHash(report)), signature);
            if (recovered != signer) revert InvalidSigner(recovered, signer);
        }
        return report.price;
    }

    function _reportStructHash(Report calldata report) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                _REPORT_TYPEHASH,
                report.version,
                report.gpuId,
                report.price,
                report.observedAt,
                report.epoch,
                report.validFrom,
                report.validUntil,
                report.calcHash
            )
        );
    }

    function _verifiedSlot(bytes32 h) private pure returns (bytes32 slot) {
        slot = keccak256(abi.encode(h, _VERIFIED_SEED));
    }

    function _verifiedTransient(bytes32 h) private view returns (bool ok) {
        bytes32 slot = _verifiedSlot(h);
        assembly ("memory-safe") {
            ok := tload(slot)
        }
    }

    function _markVerified(bytes32 h) private {
        bytes32 slot = _verifiedSlot(h);
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
    }
}
