// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {GUSD} from "../../src/GUSD.sol";
import {GPUIssuance} from "../../src/GPUIssuance.sol";
import {GPUMarketLiquidity} from "../../src/GPUMarketLiquidity.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {GPUToken} from "../../src/GPUToken.sol";
import {GPUPriceOracle} from "../../src/oracle/GPUPriceOracle.sol";
import {IGPUPriceOracle} from "../../src/oracle/IGPUPriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice The full publication path: the offchain publisher's write lands in
///         GPUPriceOracle and is immediately consumable by GPUIssuance — the
///         production oracle is a drop-in replacement for the mock.
contract OraclePublicationTest is Test {
    MockERC20 internal underlying;
    GUSD internal gusd;
    GPUPriceOracle internal oracle;
    address internal ledger = makeAddr("ledger");
    GPUIssuance internal issuance;
    IPoolManager internal manager;
    GPUMarketLiquidity internal pol;
    address internal publisher = makeAddr("publisher");
    address internal alice = makeAddr("alice");

    bytes32 internal constant H100 = bytes32(bytes("H100_SXM_80GB"));

    function setUp() public {
        vm.warp(1_000_000);
        underlying = new MockERC20("USD Coin", "USDC", 6);
        gusd = new GUSD(IERC20(address(underlying)), address(this));
        oracle = new GPUPriceOracle(address(this), publisher, 0);
        manager = new PoolManager(address(this));
        pol = new GPUMarketLiquidity(IERC20(address(gusd)), address(manager), address(this));
        issuance = new GPUIssuance(IERC20(address(gusd)), IGPUPriceOracle(address(oracle)), ledger, address(pol), address(this));
        pol.setRefs(address(issuance), makeAddr("hookless")); // hook-less rig: POL ops stay pending
        gusd.setRevenueSink(ledger);
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

    function _publish(uint256 price) internal {
        vm.prank(publisher);
        oracle.publish(H100, price, block.timestamp);
    }

    function test_publishThenIssue_exactComposition() public {
        _publish(25_000); // $2.50/GPU-hour
        vm.prank(alice);
        (uint256 base, uint256 fee) = issuance.issue(H100, 100e18, alice);
        // same worked example as GPUIssuance.t.sol: 100e18 * 25_000 / 1e16
        assertEq(base, 250_000_000);
        assertEq(fee, 1_250_000); // 50 bps
        assertEq(GPUToken(issuance.tokenOf(H100)).balanceOf(alice), 100e18);
        assertEq(pol.principalContributed(H100), 250_000_000);
        assertEq(gusd.balanceOf(ledger), 1_250_000);
    }

    function test_republishRepricesNextIssuance() public {
        _publish(25_000);
        (uint256 base0,,) = issuance.quoteIssue(H100, 1e18);
        assertEq(base0, 2_500_000);
        _publish(30_000); // $3.00/GPU-hour
        (uint256 base,,) = issuance.quoteIssue(H100, 1e18);
        assertEq(base, 3_000_000);
    }

    function test_stalenessInterplay_withIssuanceWindow() public {
        uint256 t = block.timestamp;
        vm.prank(publisher);
        oracle.publish(H100, 25_000, t);

        // the consumer's window is owner-tunable at 25 hours; PROTOCOL.md's
        // heartbeat policy (~24h) keeps a healthy publisher strictly inside it
        vm.warp(t + issuance.maxOracleStaleness());
        vm.prank(alice);
        issuance.issue(H100, 1e18, alice); // exact boundary: not stale

        vm.warp(t + issuance.maxOracleStaleness() + 1);
        vm.prank(alice);
        vm.expectRevert(GPUIssuance.OracleStale.selector);
        issuance.issue(H100, 1e18, alice);

        // heartbeat republish (same price, fresh observation) un-sticks
        // issuance with no owner action
        _publish(25_000);
        vm.prank(alice);
        issuance.issue(H100, 1e18, alice);
    }

    function test_quoteIssueIsFreshnessGatedLikeIssue() public {
        _publish(25_000);
        vm.warp(block.timestamp + issuance.maxOracleStaleness() + 1);
        // the quote path enforces the same freshness window as execution —
        // a UI can never display a price issue() would reject
        vm.expectRevert(GPUIssuance.OracleStale.selector);
        issuance.quoteIssue(H100, 1e18);
    }

    function test_futureTimestampCannotBrickIssuance() public {
        // publisher clock ran ahead of the chain clock: the oracle clamps the
        // stored updatedAt to block.timestamp, so the consumer's
        // OracleFutureTimestamp guard stays unreachable through this oracle
        vm.prank(publisher);
        oracle.publish(H100, 25_000, block.timestamp + 5);
        (, uint256 updatedAt) = oracle.getPrice(H100);
        assertEq(updatedAt, block.timestamp);
        vm.prank(alice);
        issuance.issue(H100, 1e18, alice); // must not revert
    }

    function test_deviationGuardSlowsCompromise() public {
        oracle.setMaxDeviationBps(1000); // 10% defense-in-depth bound
        _publish(25_000);

        // a compromised publisher key pushing +25% per 5s tick is rejected
        // every time — the offchain 25% jump gate caps one candidate, the
        // onchain bound caps the compounded series
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(publisher);
            vm.expectRevert(abi.encodeWithSelector(GPUPriceOracle.DeviationExceeded.selector, 25_000, 31_250, 1000));
            oracle.publish(H100, 31_250, block.timestamp);
        }

        // meanwhile issuance keeps serving the last good price
        (uint256 base,,) = issuance.quoteIssue(H100, 1e18);
        assertEq(base, 2_500_000);

        // recovery is one owner tx
        oracle.setMaxDeviationBps(3000);
        vm.prank(publisher);
        oracle.publish(H100, 31_250, block.timestamp);
        (uint256 repriced,,) = issuance.quoteIssue(H100, 1e18);
        assertEq(repriced, 3_125_000);
    }

    function test_unknownGpuPriceZero() public {
        bytes32 b200 = bytes32(bytes("B200_192GB"));
        issuance.createGpu(b200, "B200 192GB GPU-hour", "B200", 50, 3000, 60);
        issuance.setIssuanceEnabled(b200, true);
        // publisher never published B200: 0 = unknown, issuance fails closed
        vm.prank(alice);
        vm.expectRevert(GPUIssuance.OraclePriceZero.selector);
        issuance.issue(b200, 1e18, alice);
    }
}
