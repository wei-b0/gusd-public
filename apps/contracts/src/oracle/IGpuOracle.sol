// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IGpuOracle
/// @notice Pull-oracle interface for signed GPU index reports (Pyth-style). The
///         attestor signs an EIP-712 `Report` offchain and serves it through the
///         oracle API; the trade caller embeds it in the SAME transaction that
///         consumes it (`updateData`), and the consumer contract verifies and
///         consumes it here. There is no push publication, no deviation/heartbeat
///         policy on-chain, and no chain-liveness dependency: with zero users
///         there are zero oracle transactions.
/// @dev Encoding contract: `price` is USD per GPU-hour in 4-decimal fixed point
///      (real price x PRICE_SCALE = 10_000 — the scale the issuance math already
///      uses); `gpuId` is the canonical bytes32 SKU (src/libraries/GpuId.sol).
///      "Current" is defined by deterministic epoch arithmetic
///      (`currentEpoch() = block.timestamp / epochLength`), never by recency
///      guessing — the EVM cannot know whether a newer offchain report exists.
interface IGpuOracle {
    /// @notice A signed oracle report (schema V1). Signed as an EIP-712 typed
    ///         struct over domain {name:"gUSD GPU Oracle", version:"1",
    ///         chainId, verifyingContract}. Wire format:
    ///         `updateData = abi.encode(report, signature)`.
    struct Report {
        uint16 version; // schema version, currently 1
        bytes32 gpuId; // canonical SKU the price applies to
        uint256 price; // USD/GPU-hour x 10_000
        uint64 observedAt; // unix sec: engine computation time (candidate.computedAt)
        uint64 epoch; // validity epoch; must equal currentEpoch() at consumption
        uint64 validFrom; // epoch * epochLength (inclusive)
        uint64 validUntil; // validFrom + epochLength (exclusive)
        bytes32 calcHash; // methodology/receipt hash binding this report to a reproducible engine run
    }

    /// @notice A report was consumed on-chain. Emitted once per (gpuId, epoch)
    ///         by the FIRST consumer; later consumers of the same epoch emit
    ///         nothing (the binding already exists).
    event PriceConsumed(
        bytes32 indexed gpuId, uint256 price, uint64 indexed epoch, uint64 observedAt, bytes32 indexed reportHash, address caller
    );
    event SignerTransferStarted(address indexed currentSigner, address indexed nextSigner);
    event SignerAccepted(address indexed previousSigner, address indexed newSigner);
    event EpochLengthSet(uint64 seconds_);
    event MaxObservationAgeSet(uint64 seconds_);

    /// @notice Report schema version is not 1.
    error InvalidVersion(uint16 actual);
    /// @notice A zero price was submitted (0 means "unknown" and is never executable).
    error ZeroPrice();
    /// @notice The report's gpuId does not match the consuming market.
    error GpuMismatch(bytes32 expected, bytes32 actual);
    /// @notice The report is not for the current epoch (older or newer).
    error UnknownGpuEpoch(uint64 current, uint64 actual);
    /// @notice validFrom/validUntil do not exactly bound the report's epoch.
    error BadEpochBinding(uint64 validFrom, uint64 validUntil);
    /// @notice The observation time is in the future (clock skew beyond one epoch).
    error FutureObservation(uint64 observedAt, uint64 nowTs);
    /// @notice The observation is older than maxObservationAge.
    error StaleObservation(uint64 observedAt, uint64 minObservedAt);
    /// @notice The signature does not recover to the current attestor signer.
    error InvalidSigner(address recovered, address expected);
    /// @notice A different report was already consumed for this GPU in this
    ///         epoch: first-consumer-wins (equivocation defense).
    error EpochAlreadyBound(bytes32 boundHash, bytes32 actualHash);
    error NotSigner();
    error NotPendingSigner();
    error ZeroSigner();
    error EpochLengthZero();
    /// @notice maxObservationAge must be >= epochLength so a report attested at
    ///         any point of an epoch stays acceptable until the epoch ends.
    error ObservationAgeBelowEpoch(uint64 maxObservationAge, uint64 epochLength);

    /// @notice Verifies `report` against the current epoch and returns its
    ///         price. View — never writes state. Reverts unless the report is
    ///         the executable one for `gpuId` right now (see acceptance rules
    ///         in GpuOracle). Within one transaction, a report already verified
    ///         or consumed skips the ecrecover (transient dedupe).
    function verify(bytes32 gpuId, Report calldata report, bytes calldata signature) external view returns (uint256 price);

    /// @notice Verifies, applies the first-consumer-per-epoch binding, records
    ///         observability state, and returns the price. Permissionless —
    ///         anyone may pre-warm the current epoch. Emits `PriceConsumed`
    ///         only when this is the first consumption of (gpuId, epoch).
    function consume(bytes32 gpuId, Report calldata report, bytes calldata signature) external returns (uint256 price);

    /// @notice keccak256(abi.encode(report, signature)) — the report identity
    ///         used for the epoch binding and transient dedupe. "Same report"
    ///         means byte-identical updateData.
    function reportHash(Report calldata report, bytes calldata signature) external pure returns (bytes32);

    /// @notice The EIP-712 digest a signer must sign for this report.
    function reportDigest(Report calldata report) external view returns (bytes32);

    /// @notice The currently executable epoch: block.timestamp / epochLength.
    function currentEpoch() external view returns (uint64);

    function epochLength() external view returns (uint64);
    function maxObservationAge() external view returns (uint64);
    function signer() external view returns (address);
    function pendingSigner() external view returns (address);

    /// @dev OBSERVABILITY ONLY — these describe the last report consumed
    ///      on-chain and must NEVER be used as a price input by any protocol
    ///      contract. The executable price is always the report consumed in
    ///      the caller's transaction, never this cache.
    function lastConsumedPrice(bytes32 gpuId) external view returns (uint256);
    function lastConsumedAt(bytes32 gpuId) external view returns (uint64);
    function lastConsumedEpoch(bytes32 gpuId) external view returns (uint64);
    function lastConsumedReportHash(bytes32 gpuId) external view returns (bytes32);

    /// @notice Starts 2-step signer rotation (mirrors Ownable2Step). Current signer only.
    function transferSigner(address next) external;

    /// @notice The pending signer accepts the role.
    function acceptSigner() external;

    function setEpochLength(uint64 seconds_) external;
    function setMaxObservationAge(uint64 seconds_) external;
}
