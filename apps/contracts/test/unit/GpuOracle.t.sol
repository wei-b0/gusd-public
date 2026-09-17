// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {GpuOracle} from "../../src/oracle/GpuOracle.sol";
import {IGpuOracle} from "../../src/oracle/IGpuOracle.sol";
import {ReportCodec} from "../../src/oracle/ReportCodec.sol";

contract GpuOracleTest is Test {
    GpuOracle internal oracle;

    uint256 internal constant SIGNER_PK = 0xA11CE;
    uint256 internal constant OTHER_PK = 0xB0B;
    address internal signerAddr;
    address internal alice = makeAddr("alice");

    bytes32 internal constant H100 = bytes32(bytes("H100_SXM_80GB"));
    bytes32 internal constant H200 = bytes32(bytes("H200_141GB"));

    uint64 internal constant EPOCH_LENGTH = 60;
    uint64 internal constant MAX_AGE = 300;

    function setUp() public {
        vm.warp(1_000_000);
        signerAddr = vm.addr(SIGNER_PK);
        oracle = new GpuOracle(address(this), signerAddr, EPOCH_LENGTH, MAX_AGE);
    }

    // ------------------------------------------------------------ fixtures

    function _report() internal view returns (IGpuOracle.Report memory) {
        return _report(H100, 25_000);
    }

    function _report(bytes32 gpuId, uint256 price) internal view returns (IGpuOracle.Report memory r) {
        uint64 epoch = uint64(block.timestamp / EPOCH_LENGTH);
        r = IGpuOracle.Report({
            version: 1,
            gpuId: gpuId,
            price: price,
            observedAt: uint64(block.timestamp - 5),
            epoch: epoch,
            validFrom: epoch * EPOCH_LENGTH,
            validUntil: (epoch + 1) * EPOCH_LENGTH,
            calcHash: bytes32(uint256(0xC0DEC0DE))
        });
    }

    function _sign(uint256 pk, IGpuOracle.Report memory r) internal view returns (bytes memory sig) {
        (uint8 v, bytes32 r32, bytes32 s) = vm.sign(pk, oracle.reportDigest(r));
        sig = abi.encodePacked(r32, s, v);
    }

    /// @dev Splits a 65-byte (r, s, v) signature so tests can re-run the
    ///      precompile recovery for deterministic expected-error args.
    function _split(bytes memory sig) internal pure returns (uint8 v, bytes32 r32, bytes32 s32) {
        assembly ("memory-safe") {
            r32 := mload(add(sig, 0x20))
            s32 := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
    }

    // ------------------------------------------------------------- defaults

    function test_defaults() public view {
        assertEq(oracle.epochLength(), EPOCH_LENGTH);
        assertEq(oracle.maxObservationAge(), MAX_AGE);
        assertEq(oracle.signer(), signerAddr);
        assertEq(oracle.pendingSigner(), address(0));
        assertEq(oracle.currentEpoch(), 1_000_000 / EPOCH_LENGTH);
    }

    function test_constructor_zeroSignerReverts() public {
        vm.expectRevert(IGpuOracle.ZeroSigner.selector);
        new GpuOracle(address(this), address(0), EPOCH_LENGTH, MAX_AGE);
    }

    function test_constructor_zeroEpochLengthReverts() public {
        vm.expectRevert(IGpuOracle.EpochLengthZero.selector);
        new GpuOracle(address(this), signerAddr, 0, MAX_AGE);
    }

    function test_constructor_maxAgeBelowEpochReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IGpuOracle.ObservationAgeBelowEpoch.selector, 30, EPOCH_LENGTH));
        new GpuOracle(address(this), signerAddr, EPOCH_LENGTH, 30);
    }

    // ------------------------------------------------------------- acceptance

    function test_verify_validReturnsPrice_withoutState() public {
        IGpuOracle.Report memory r = _report();
        bytes memory sig = _sign(SIGNER_PK, r);
        assertEq(oracle.verify(H100, r, sig), 25_000);
        // verify is a pure read: nothing consumed, nothing bound
        assertEq(oracle.lastConsumedPrice(H100), 0);
        assertEq(oracle.lastConsumedAt(H100), 0);
        assertEq(oracle.lastConsumedEpoch(H100), 0);
        assertEq(oracle.lastConsumedReportHash(H100), bytes32(0));
    }

    function test_consume_bindsAndEmitsOnce() public {
        IGpuOracle.Report memory r = _report();
        bytes memory sig = _sign(SIGNER_PK, r);
        bytes32 h = oracle.reportHash(r, sig);

        vm.expectEmit(address(oracle));
        emit IGpuOracle.PriceConsumed(H100, 25_000, r.epoch, r.observedAt, h, address(this));
        assertEq(oracle.consume(H100, r, sig), 25_000);

        assertEq(oracle.lastConsumedPrice(H100), 25_000);
        assertEq(oracle.lastConsumedAt(H100), r.observedAt);
        assertEq(oracle.lastConsumedEpoch(H100), r.epoch);
        assertEq(oracle.lastConsumedReportHash(H100), h);

        // duplicate consumption of the byte-identical report: idempotent, no event
        vm.recordLogs();
        assertEq(oracle.consume(H100, r, sig), 25_000);
        assertEq(vm.getRecordedLogs().length, 0, "duplicate consume must not re-emit");
    }

    function test_consume_isPermissionless() public {
        IGpuOracle.Report memory r = _report();
        vm.prank(alice); // anyone may pre-warm the current epoch
        assertEq(oracle.consume(H100, r, _sign(SIGNER_PK, r)), 25_000);
    }

    function test_consume_equivocationReverts_firstConsumerWins() public {
        IGpuOracle.Report memory rA = _report(H100, 25_000);
        bytes memory sigA = _sign(SIGNER_PK, rA);
        oracle.consume(H100, rA, sigA);

        // a second, different report for the SAME epoch (e.g. re-signed price)
        IGpuOracle.Report memory rB = _report(H100, 26_000);
        bytes memory sigB = _sign(SIGNER_PK, rB);
        vm.expectRevert(
            abi.encodeWithSelector(IGpuOracle.EpochAlreadyBound.selector, oracle.reportHash(rA, sigA), oracle.reportHash(rB, sigB))
        );
        oracle.consume(H100, rB, sigB);

        // the binding is untouched: the first report stays the executable one
        assertEq(oracle.lastConsumedPrice(H100), 25_000);
        assertEq(oracle.lastConsumedReportHash(H100), oracle.reportHash(rA, sigA));
    }

    function test_consume_resignedContentCannotPoisonTheBinding() public {
        // The reportHash binds the full (Report, signature) bytes, but a
        // byte-different signature over identical content can never reach the
        // binding: a different key fails verify (InvalidSigner, which runs
        // first), and a malleated signature from the SAME key is rejected by
        // ECDSA's high-s check — so first-consumer-wins only ever sees
        // attestor-signed bytes. Equivocation over DIFFERENT content is
        // covered by test_consume_equivocationReverts_firstConsumerWins.
        IGpuOracle.Report memory r = _report();
        bytes memory sigA = _sign(SIGNER_PK, r);
        bytes memory sigB = _sign(OTHER_PK, r); // pre-computed: argument calls would eat the expectation
        oracle.consume(H100, r, sigA);
        vm.expectRevert(abi.encodeWithSelector(IGpuOracle.InvalidSigner.selector, vm.addr(OTHER_PK), signerAddr));
        oracle.consume(H100, r, sigB);
        // the binding is untouched: the first report stays the executable one
        assertEq(oracle.lastConsumedPrice(H100), 25_000);
        assertEq(oracle.lastConsumedReportHash(H100), oracle.reportHash(r, sigA));
    }

    function test_consume_nextEpochRebinds() public {
        IGpuOracle.Report memory r1 = _report();
        oracle.consume(H100, r1, _sign(SIGNER_PK, r1));

        vm.warp(block.timestamp + EPOCH_LENGTH); // new epoch
        IGpuOracle.Report memory r2 = _report(H100, 26_500);
        bytes32 h2 = oracle.reportHash(r2, _sign(SIGNER_PK, r2));

        vm.expectEmit(address(oracle));
        emit IGpuOracle.PriceConsumed(H100, 26_500, r2.epoch, r2.observedAt, h2, address(this));
        oracle.consume(H100, r2, _sign(SIGNER_PK, r2));

        assertEq(oracle.lastConsumedPrice(H100), 26_500);
        assertEq(oracle.lastConsumedEpoch(H100), r2.epoch);
        assertEq(oracle.lastConsumedReportHash(H100), h2);
    }

    // -------------------------------------------------- acceptance rejections

    function test_verify_wrongVersionReverts() public {
        IGpuOracle.Report memory r = _report();
        r.version = 2;
        bytes memory sig = _sign(SIGNER_PK, r); // pre-computed: argument calls would eat the expectation
        vm.expectRevert(abi.encodeWithSelector(IGpuOracle.InvalidVersion.selector, 2));
        oracle.verify(H100, r, sig);
    }

    function test_verify_zeroPriceReverts() public {
        IGpuOracle.Report memory r = _report(H100, 0);
        bytes memory sig = _sign(SIGNER_PK, r); // pre-computed: argument calls would eat the expectation
        vm.expectRevert(IGpuOracle.ZeroPrice.selector);
        oracle.verify(H100, r, sig);
    }

    function test_verify_wrongGpuReverts() public {
        IGpuOracle.Report memory r = _report(H200, 12_000); // H200 report…
        bytes memory sig = _sign(SIGNER_PK, r); // pre-computed: argument calls would eat the expectation
        vm.expectRevert(abi.encodeWithSelector(IGpuOracle.GpuMismatch.selector, H100, H200));
        oracle.verify(H100, r, sig); // …consumed as H100
    }

    function test_verify_oldEpochReverts() public {
        IGpuOracle.Report memory r = _report();
        bytes memory sig = _sign(SIGNER_PK, r);
        vm.warp(block.timestamp + 3 * EPOCH_LENGTH); // two epochs past validUntil
        vm.expectRevert(abi.encodeWithSelector(IGpuOracle.UnknownGpuEpoch.selector, oracle.currentEpoch(), r.epoch));
        oracle.verify(H100, r, sig);
    }

    function test_verify_futureEpochReverts() public {
        IGpuOracle.Report memory r = _report();
        r.epoch = r.epoch + 1;
        r.validFrom = r.epoch * EPOCH_LENGTH;
        r.validUntil = (r.epoch + 1) * EPOCH_LENGTH;
        bytes memory sig = _sign(SIGNER_PK, r); // pre-computed: argument calls would eat the expectation
        vm.expectRevert(abi.encodeWithSelector(IGpuOracle.UnknownGpuEpoch.selector, oracle.currentEpoch(), r.epoch));
        oracle.verify(H100, r, sig);
    }

    function test_verify_badValidFromReverts() public {
        IGpuOracle.Report memory r = _report();
        r.validFrom = r.validFrom + 1;
        bytes memory sig = _sign(SIGNER_PK, r); // pre-computed: argument calls would eat the expectation
        vm.expectRevert(abi.encodeWithSelector(IGpuOracle.BadEpochBinding.selector, r.validFrom, r.validUntil));
        oracle.verify(H100, r, sig);
    }

    function test_verify_badValidUntilReverts() public {
        IGpuOracle.Report memory r = _report();
        r.validUntil = r.validUntil - 1;
        bytes memory sig = _sign(SIGNER_PK, r); // pre-computed: argument calls would eat the expectation
        vm.expectRevert(abi.encodeWithSelector(IGpuOracle.BadEpochBinding.selector, r.validFrom, r.validUntil));
        oracle.verify(H100, r, sig);
    }

    function test_verify_futureObservationReverts() public {
        IGpuOracle.Report memory r = _report();
        r.observedAt = uint64(block.timestamp + 10); // still inside the epoch, but ahead of the chain clock
        bytes memory sig = _sign(SIGNER_PK, r); // pre-computed: argument calls would eat the expectation
        vm.expectRevert(
            abi.encodeWithSelector(IGpuOracle.FutureObservation.selector, r.observedAt, block.timestamp)
        );
        oracle.verify(H100, r, sig);
    }

    function test_verify_staleObservationReverts() public {
        IGpuOracle.Report memory r = _report();
        r.observedAt = uint64(block.timestamp - MAX_AGE - 1);
        bytes memory sig = _sign(SIGNER_PK, r); // pre-computed: argument calls would eat the expectation
        vm.expectRevert(
            abi.encodeWithSelector(IGpuOracle.StaleObservation.selector, r.observedAt, block.timestamp - MAX_AGE)
        );
        oracle.verify(H100, r, sig);
    }

    function test_verify_observationAtMaxAgeBoundaryPasses() public {
        IGpuOracle.Report memory r = _report();
        r.observedAt = uint64(block.timestamp - MAX_AGE); // exactly at the floor
        assertEq(oracle.verify(H100, r, _sign(SIGNER_PK, r)), 25_000);
    }

    function test_verify_wrongSignerReverts() public {
        IGpuOracle.Report memory r = _report();
        bytes memory sig = _sign(OTHER_PK, r); // pre-computed: argument calls would eat the expectation
        vm.expectRevert(
            abi.encodeWithSelector(IGpuOracle.InvalidSigner.selector, vm.addr(OTHER_PK), signerAddr)
        );
        oracle.verify(H100, r, sig);
    }

    function test_verify_tamperedReportReverts() public {
        // sign a valid report, then change a field: the EIP-712 digest no
        // longer matches, so recovery lands on an address that is not the signer
        IGpuOracle.Report memory r = _report();
        bytes memory sig = _sign(SIGNER_PK, r);
        r.price = 26_000;
        // recovery over the tampered digest is deterministic: recover with the
        // precompile to state the expected error args exactly
        bytes32 tamperedDigest = oracle.reportDigest(r);
        (uint8 v, bytes32 r32, bytes32 s32) = _split(sig);
        address recovered = ecrecover(tamperedDigest, v, r32, s32);
        vm.expectRevert(abi.encodeWithSelector(IGpuOracle.InvalidSigner.selector, recovered, signerAddr));
        oracle.verify(H100, r, sig);
    }

    function test_verify_wrongChainReverts() public {
        // the EIP-712 domain binds chainId: a signature produced for another
        // chain (or another verifying contract) cannot verify here
        IGpuOracle.Report memory r = _report();
        bytes memory sig = _sign(SIGNER_PK, r); // signed for this chain's domain
        vm.chainId(1);
        // the oracle now hashes a different domain: recovery lands on a
        // deterministic-but-wrong address, stated exactly
        bytes32 otherDigest = oracle.reportDigest(r);
        (uint8 v, bytes32 r32, bytes32 s32) = _split(sig);
        address recovered = ecrecover(otherDigest, v, r32, s32);
        vm.expectRevert(abi.encodeWithSelector(IGpuOracle.InvalidSigner.selector, recovered, signerAddr));
        oracle.verify(H100, r, sig);
        vm.chainId(31_337);
    }

    function test_verify_malformedSignatureReverts() public {
        IGpuOracle.Report memory r = _report();
        bytes memory short = new bytes(63);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 63));
        oracle.verify(H100, r, short);
    }

    // --------------------------------------------------------- transient dedupe

    function test_verify_dedupeSkipsEcrecoverWithinTx() public {
        IGpuOracle.Report memory r = _report();
        bytes memory sig = _sign(SIGNER_PK, r);
        oracle.consume(H100, r, sig); // marks the report verified for this tx

        uint256 g0 = gasleft();
        oracle.verify(H100, r, sig); // transient hit: no ecrecover
        uint256 usedDedup = g0 - gasleft();

        IGpuOracle.Report memory r2 = _report(H200, 12_345);
        bytes memory sig2 = _sign(SIGNER_PK, r2);
        uint256 g1 = gasleft();
        oracle.verify(H200, r2, sig2); // fresh verification: full ecrecover
        uint256 usedFresh = g1 - gasleft();

        assertLt(usedDedup, usedFresh, "dedupe path must be cheaper than a fresh verify");
    }

    // -------------------------------------------------------------- report hash

    function test_reportHash_bindsFullWireFormat() public {
        IGpuOracle.Report memory r = _report();
        bytes memory sig = _sign(SIGNER_PK, r);
        assertEq(oracle.reportHash(r, sig), keccak256(abi.encode(r, sig)));
        // a different signature (different key) yields a different report hash
        assertTrue(oracle.reportHash(r, sig) != oracle.reportHash(r, _sign(OTHER_PK, r)));
    }

    // ---------------------------------------------------------- signer rotation

    function test_transferSigner_onlySigner() public {
        vm.prank(alice);
        vm.expectRevert(IGpuOracle.NotSigner.selector);
        oracle.transferSigner(alice);
        // the owner tunes parameters but does not control signing
        vm.expectRevert(IGpuOracle.NotSigner.selector);
        oracle.transferSigner(alice);
    }

    function test_transferSigner_zeroReverts() public {
        vm.prank(signerAddr);
        vm.expectRevert(IGpuOracle.ZeroSigner.selector);
        oracle.transferSigner(address(0));
    }

    function test_signerRotationLifecycle() public {
        address next = vm.addr(OTHER_PK);
        vm.prank(signerAddr);
        vm.expectEmit(address(oracle));
        emit IGpuOracle.SignerTransferStarted(signerAddr, next);
        oracle.transferSigner(next);

        vm.prank(alice);
        vm.expectRevert(IGpuOracle.NotPendingSigner.selector);
        oracle.acceptSigner();

        vm.expectEmit(address(oracle));
        emit IGpuOracle.SignerAccepted(signerAddr, next);
        vm.prank(next);
        oracle.acceptSigner();

        assertEq(oracle.signer(), next);
        assertEq(oracle.pendingSigner(), address(0));

        IGpuOracle.Report memory r = _report();
        bytes memory oldSig = _sign(SIGNER_PK, r); // pre-computed: argument calls would eat the expectation
        bytes memory newSig = _sign(OTHER_PK, r);
        // the old signer's reports are rejected…
        vm.expectRevert(abi.encodeWithSelector(IGpuOracle.InvalidSigner.selector, signerAddr, next));
        oracle.verify(H100, r, oldSig);
        // …and the new signer's verify
        assertEq(oracle.verify(H100, r, newSig), 25_000);
    }

    // ------------------------------------------------------------ admin params

    function test_setEpochLength_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        oracle.setEpochLength(120);
    }

    function test_setEpochLength_zeroReverts() public {
        vm.expectRevert(IGpuOracle.EpochLengthZero.selector);
        oracle.setEpochLength(0);
    }

    function test_setEpochLength_aboveMaxAgeReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IGpuOracle.ObservationAgeBelowEpoch.selector, MAX_AGE, 400));
        oracle.setEpochLength(400);
    }

    function test_setEpochLength_movesTheEpochGrid() public {
        IGpuOracle.Report memory r = _report();
        oracle.consume(H100, r, _sign(SIGNER_PK, r));

        vm.expectEmit(address(oracle));
        emit IGpuOracle.EpochLengthSet(120);
        oracle.setEpochLength(120);

        assertEq(oracle.epochLength(), 120);
        assertEq(oracle.currentEpoch(), uint64(1_000_000) / 120); // floor
        // the previous report is no longer executable on the new grid
        bytes memory sig = _sign(SIGNER_PK, r); // pre-computed: argument calls would eat the expectation
        vm.expectRevert(abi.encodeWithSelector(IGpuOracle.UnknownGpuEpoch.selector, oracle.currentEpoch(), r.epoch));
        oracle.verify(H100, r, sig);
    }

    function test_setMaxObservationAge_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        oracle.setMaxObservationAge(600);
    }

    function test_setMaxObservationAge_belowEpochReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IGpuOracle.ObservationAgeBelowEpoch.selector, 30, EPOCH_LENGTH));
        oracle.setMaxObservationAge(30);
    }

    function test_setMaxObservationAge_event() public {
        vm.expectEmit(address(oracle));
        emit IGpuOracle.MaxObservationAgeSet(600);
        oracle.setMaxObservationAge(600);
        assertEq(oracle.maxObservationAge(), 600);
    }
}
