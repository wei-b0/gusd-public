// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {GUSD} from "../../src/GUSD.sol";
import {GPUIssuance} from "../../src/GPUIssuance.sol";
import {GPUMarketLiquidity} from "../../src/GPUMarketLiquidity.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {GPUToken} from "../../src/GPUToken.sol";
import {IGpuOracle} from "../../src/oracle/IGpuOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OracleReports} from "../utils/OracleReports.sol";
import {VmSafe} from "forge-std/Vm.sol";

/// @title AttestationConsumption
/// @notice The full consumption path of the pull oracle: the attestor signs an
///         EIP-712 report offchain and serves it over the API; the trade caller
///         embeds it as `updateData` in the SAME transaction that prices the
///         trade, and GPUIssuance verifies/consumes it through the real
///         GpuOracle. Replaces the push-publication suite
///         (OraclePublication.t.sol): there is no publisher write, no
///         deviation/heartbeat policy on-chain — the report acceptance set plus
///         the first-consumer-per-epoch binding are the entire security model.
contract AttestationConsumptionTest is OracleReports {
    MockERC20 internal underlying;
    GUSD internal gusd;
    address internal ledger = makeAddr("ledger");
    GPUIssuance internal issuance;
    PoolManager internal poolManager;
    GPUMarketLiquidity internal pol;
    address internal deliverer = makeAddr("deliverer"); // any wallet can carry the report
    address internal alice = makeAddr("alice");

    function setUp() public {
        _deployOracle();
        underlying = new MockERC20("USD Coin", "USDC", 6);
        gusd = new GUSD(IERC20(address(underlying)), address(this));
        poolManager = new PoolManager(address(this));
        pol = new GPUMarketLiquidity(IERC20(address(gusd)), address(poolManager), address(this));
        issuance = new GPUIssuance(IERC20(address(gusd)), oracle, ledger, address(pol), address(this));
        gusd.setRevenueSink(ledger);
        pol.setRefs(address(issuance), makeAddr("hookless")); // hook-less rig: POL ops stay pending
        issuance.createGpu(H100, "H100 SXM 80GB GPU-hour", "H100", 50, 3000, 60);
        issuance.setIssuanceEnabled(H100, true);
        // fund alice with gUSD
        underlying.mint(alice, 1_000_000e6);
        vm.startPrank(alice);
        underlying.approve(address(gusd), type(uint256).max);
        gusd.mint(10_000e6, alice);
        gusd.approve(address(issuance), type(uint256).max);
        vm.stopPrank();
    }

    // --------------------------------------------------------------- tests

    /// The attestor's signature travels inside the caller's transaction: no
    /// oracle transaction, no publisher liveness — alice's issuance IS the
    /// only oracle write, and the worked example matches GPUIssuance.t.sol.
    function test_attestThenIssue_exactComposition() public {
        vm.prank(alice);
        (uint256 base, uint256 fee) = issuance.issue(H100, 100e18, alice, _updateData(H100, 25_000));
        assertEq(base, 250_000_000);
        assertEq(fee, 1_250_000); // 50 bps
        assertEq(GPUToken(issuance.tokenOf(H100)).balanceOf(alice), 100e18);
        assertEq(pol.principalContributed(H100), 250_000_000);
        assertEq(gusd.balanceOf(ledger), 1_250_000);
        // the report is CONSUMED: the oracle's observability cache mirrors it
        assertEq(oracle.lastConsumedPrice(H100), 25_000);
        assertEq(oracle.lastConsumedEpoch(H100), block.timestamp / EPOCH_LENGTH);
    }

    /// The attestor never sends a transaction: it signs offchain and any
    /// wallet — here a bystander pre-warming the epoch — delivers the report.
    /// The first consumer owns the epoch binding and the PriceConsumed event;
    /// later consumers of the same epoch emit nothing.
    function test_anyWalletCanDeliver_attestorIsNeverOnchain() public {
        IGpuOracle.Report memory r = _report(H100, 25_000);

        vm.recordLogs();
        vm.prank(deliverer);
        oracle.consume(H100, r, _sign(r));
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        (uint256 n, address caller) = _priceConsumedCount(logs);
        assertEq(n, 1, "first consumer emits");
        assertEq(caller, deliverer, "event credits the deliverer");

        // alice's trade replays the same attestation: binding already exists,
        // idempotent, and NO second PriceConsumed
        vm.recordLogs();
        vm.prank(alice);
        (uint256 base,) = issuance.issue(H100, 100e18, alice, _updateDataFor(r));
        assertEq(base, 250_000_000);
        (n,) = _priceConsumedCount(vm.getRecordedLogs());
        assertEq(n, 0, "second consumer emits nothing");
    }

    /// One price per epoch: a compromised or buggy attestor pushing a
    /// different price within the same epoch is an equivocation — execution is
    /// first-consumer-wins, so the epoch is bound to the price the market
    /// actually traded at. Recovery needs no owner tx (the push oracle needed
    /// setMaxDeviationBps): wait out the epoch and re-attest.
    function test_onePricePerEpoch_equivocationBound() public {
        vm.prank(alice);
        issuance.issue(H100, 1e18, alice, _updateData(H100, 25_000));

        IGpuOracle.Report memory r2 = _report(H100, 31_250);
        vm.expectRevert(
            abi.encodeWithSelector(
                IGpuOracle.EpochAlreadyBound.selector,
                oracle.lastConsumedReportHash(H100),
                oracle.reportHash(r2, _sign(r2))
            )
        );
        vm.prank(alice);
        issuance.issue(H100, 1e18, alice, _updateDataFor(r2));

        _nextEpoch();
        vm.prank(alice);
        (uint256 base,) = issuance.issue(H100, 1e18, alice, _updateData(H100, 31_250));
        assertEq(base, 3_125_000);
    }

    /// Repricing is epoch arithmetic: a fresh attestation for the next epoch
    /// prices the next issuance — no owner action, no publication tx.
    function test_newEpochRepricesNextIssuance() public {
        (uint256 base0,,) = issuance.quoteIssue(H100, 1e18, _updateData(H100, 25_000));
        assertEq(base0, 2_500_000);
        _nextEpoch();
        (uint256 base,,) = issuance.quoteIssue(H100, 1e18, _updateData(H100, 30_000));
        assertEq(base, 3_000_000);
    }

    /// The staleness floor (maxObservationAge) is enforced identically on the
    /// quote and execution paths — a UI can never display a price the trade
    /// would reject for staleness.
    function test_stalenessBoundary_matchesExecutionAndQuote() public {
        // exactly maxObservationAge: executable
        vm.prank(alice);
        issuance.issue(H100, 1e18, alice, _updateDataFor(_reportAt(H100, 25_000, uint64(block.timestamp - MAX_AGE))));
        (uint256 base,,) = issuance.quoteIssue(H100, 1e18, _updateData(H100, 25_000));
        assertEq(base, 2_500_000);

        // one second past the floor, next epoch: both paths fail closed
        _nextEpoch();
        IGpuOracle.Report memory stale = _reportAt(H100, 25_000, uint64(block.timestamp - MAX_AGE - 1));
        vm.expectRevert(
            abi.encodeWithSelector(
                IGpuOracle.StaleObservation.selector, stale.observedAt, uint64(block.timestamp - MAX_AGE)
            )
        );
        issuance.quoteIssue(H100, 1e18, _updateDataFor(stale));
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IGpuOracle.StaleObservation.selector, stale.observedAt, uint64(block.timestamp - MAX_AGE)
            )
        );
        issuance.issue(H100, 1e18, alice, _updateDataFor(stale));
    }

    /// A skewed attestation (observedAt in the future) reverts inside the
    /// caller's transaction and lands in NO storage — the market cannot be
    /// stranded by bad data the way a pushed bad publication would. The next
    /// honest report executes in the same epoch.
    function test_futureObservation_isRejectedNotStored() public {
        IGpuOracle.Report memory future = _reportAt(H100, 25_000, uint64(block.timestamp + 1));
        vm.expectRevert(
            abi.encodeWithSelector(
                IGpuOracle.FutureObservation.selector, uint64(block.timestamp + 1), block.timestamp
            )
        );
        issuance.quoteIssue(H100, 1e18, _updateDataFor(future));

        vm.prank(alice);
        (uint256 base,) = issuance.issue(H100, 1e18, alice, _updateData(H100, 25_000));
        assertEq(base, 2_500_000);
    }

    /// A forged attestation — any key but the attestor's — recovers to the
    /// wrong signer and can never price a trade.
    function test_forgedAttestationReverts() public {
        IGpuOracle.Report memory r = _report(H100, 25_000);
        (uint8 v, bytes32 r32, bytes32 s) = vm.sign(0xB0B, oracle.reportDigest(r));
        vm.expectRevert(abi.encodeWithSelector(IGpuOracle.InvalidSigner.selector, vm.addr(0xB0B), signer));
        issuance.quoteIssue(H100, 1e18, abi.encode(r, abi.encodePacked(r32, s, v)));
    }

    /// A zero price report (0 = "unknown") fails closed.
    function test_zeroPriceReportFailsClosed() public {
        vm.prank(alice);
        vm.expectRevert(IGpuOracle.ZeroPrice.selector);
        issuance.issue(H100, 1e18, alice, _updateData(H100, 0));
    }

    /// A GPU with no attestation of its own cannot be priced: replaying
    /// another SKU's report is a GpuMismatch — every market consumes only its
    /// own canonical gpuId.
    function test_wrongGpuReportReverts() public {
        issuance.createGpu(H200, "B200 192GB GPU-hour", "B200", 50, 3000, 60);
        issuance.setIssuanceEnabled(H200, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IGpuOracle.GpuMismatch.selector, H200, H100));
        issuance.issue(H200, 1e18, alice, _updateData(H100, 25_000));
    }

    /// A second trade in the same epoch replays the byte-identical
    /// attestation: consume dedupes against the binding and the trade executes
    /// at the same price.
    function test_idempotentReconsumeSameEpoch() public {
        bytes memory updateData = _updateData(H100, 25_000);
        vm.prank(alice);
        issuance.issue(H100, 1e18, alice, updateData);
        vm.prank(alice);
        (uint256 base,) = issuance.issue(H100, 1e18, alice, updateData);
        assertEq(base, 2_500_000);
        assertEq(oracle.lastConsumedEpoch(H100), block.timestamp / EPOCH_LENGTH);
        assertEq(oracle.lastConsumedPrice(H100), 25_000);
    }

    // ------------------------------------------------------------- helpers

    /// Counts PriceConsumed events in a recorded-log batch and returns the
    /// caller of the first one (non-indexed tail of the event's data).
    function _priceConsumedCount(VmSafe.Log[] memory logs)
        internal
        pure
        returns (uint256 n, address firstCaller)
    {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == IGpuOracle.PriceConsumed.selector) {
                if (n == 0) (, , firstCaller) = abi.decode(logs[i].data, (uint256, uint64, address));
                n++;
            }
        }
    }
}
