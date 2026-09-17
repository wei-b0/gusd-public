// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {GUSD} from "../../src/GUSD.sol";
import {GPUIssuance} from "../../src/GPUIssuance.sol";
import {IGPUIssuance} from "../../src/interfaces/IGPUIssuance.sol";
import {GPUToken} from "../../src/GPUToken.sol";
import {IGpuOracle} from "../../src/oracle/IGpuOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {GPUMarketLiquidity} from "../../src/GPUMarketLiquidity.sol";
import {OracleReports} from "../utils/OracleReports.sol";

contract GPUIssuanceTest is OracleReports {
    MockERC20 internal underlying;
    GUSD internal gusd;
    address internal ledger = makeAddr("ledger");
    GPUIssuance internal issuance;
    PoolManager internal poolManager;
    GPUMarketLiquidity internal pol;
    address internal alice = makeAddr("alice");

    function setUp() public {
        _deployOracle();
        underlying = new MockERC20("USD Coin", "USDC", 6);
        gusd = new GUSD(IERC20(address(underlying)), address(this));
        poolManager = new PoolManager(address(this));
        pol = new GPUMarketLiquidity(IERC20(address(gusd)), address(poolManager), address(this));
        issuance = new GPUIssuance(IERC20(address(gusd)), oracle, ledger, address(pol), address(this));
        gusd.setRevenueSink(ledger); // any sink ok for tests
        pol.setRefs(address(issuance), makeAddr("hookless")); // minimal rig: no hook calls
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

    function test_workedExample_100H100_at_2_50() public {
        vm.prank(alice);
        (uint256 base, uint256 fee) = issuance.issue(H100, 100e18, alice, _updateData(H100, 25_000));
        // base = 100e18 * 25_000 / 1e16 = 250_000_000 = 250.000000 gUSD
        assertEq(base, 250_000_000);
        // fee = ceil(250_000_000 * 50 / 10_000) = 1_250_000 = 1.25 gUSD
        assertEq(fee, 1_250_000);
        assertEq(GPUToken(issuance.tokenOf(H100)).balanceOf(alice), 100e18);
        // principal -> vault custody: bid capacity immediately (the staging
        // phase is gone); issuance holds zero gUSD at rest
        assertEq(pol.bidInventoryGusd(H100), 250_000_000);
        assertEq(pol.principalContributed(H100), 250_000_000);
        assertEq(gusd.balanceOf(address(pol)), 250_000_000);
        assertEq(gusd.balanceOf(ledger), 1_250_000);
        assertEq(gusd.balanceOf(address(issuance)), 0);
        // the report is CONSUMED: the oracle's last-executed state matches
        assertEq(oracle.lastConsumedPrice(H100), 25_000);
        assertEq(oracle.lastConsumedEpoch(H100), block.timestamp / EPOCH_LENGTH);
    }

    function test_quoteMatchesCharge() public {
        (uint256 qb, uint256 qf, uint256 qt) = issuance.quoteIssue(H100, 100e18, _updateData(H100, 25_000));
        assertEq(qb, 250_000_000);
        assertEq(qf, 1_250_000);
        assertEq(qt, 251_250_000);
        vm.prank(alice);
        (uint256 base, uint256 fee) = issuance.issue(H100, 100e18, alice, _updateData(H100, 25_000));
        assertEq(base, qb);
        assertEq(fee, qf);
    }

    function test_ceilOnIndivisibleBase() public {
        // 1 wei of H100 at 2.5000: base = 1e18*25000/1e16 = 2500 exactly.
        // 3 wei: 7500. Non-divisible: 1e18/7 wei -> ceil.
        uint256 amount = (1e18 - 1) / 7 + 1;
        vm.prank(alice);
        (uint256 base,) = issuance.issue(H100, amount, alice, _updateData(H100, 25_000));
        // amount*price/1e16 = 357142.857... -> ceil 357143
        assertEq(base, 357_143);
        assertEq(pol.principalContributed(H100), 357_143);
    }

    function test_ceilOnFee() public {
        // fee 1 bps on base 101 -> ceil(101*1/1e4)=1... use fee 50 on base 101 -> 1
        issuance.setIssuanceFee(H100, 50);
        uint256 amount = 1e14; // base = 1e14*25000/1e16 = 250
        vm.prank(alice);
        (, uint256 fee) = issuance.issue(H100, amount, alice, _updateData(H100, 25_000));
        assertEq(fee, 2); // ceil(250*50/1e4) = ceil(1.25) = 2
    }

    function test_unknownGpuReverts() public {
        vm.expectRevert(GPUIssuance.UnknownGpuId.selector);
        issuance.issue(bytes32(bytes("FAKE_GPU")), 1e18, alice, _updateData(H100, 25_000));
    }

    function test_disabledGpuReverts() public {
        issuance.setIssuanceEnabled(H100, false);
        vm.expectRevert(GPUIssuance.IssuanceDisabled.selector);
        issuance.issue(H100, 1e18, alice, _updateData(H100, 25_000));
    }

    function test_zeroPriceReportReverts() public {
        vm.expectRevert(IGpuOracle.ZeroPrice.selector);
        issuance.issue(H100, 1e18, alice, _updateData(H100, 0));
    }

    function test_epochMustBeCurrent() public {
        // a report signed for the previous epoch can never price an issuance
        IGpuOracle.Report memory r = _report(H100, 25_000);
        bytes memory updateData = _updateDataFor(r);
        _nextEpoch();
        vm.expectRevert(
            abi.encodeWithSelector(IGpuOracle.UnknownGpuEpoch.selector, oracle.currentEpoch(), r.epoch)
        );
        issuance.issue(H100, 1e18, alice, updateData);
    }

    function test_stalenessBoundary() public {
        // exactly maxObservationAge passes
        vm.prank(alice);
        issuance.issue(H100, 1e18, alice, _updateDataFor(_reportAt(H100, 25_000, uint64(block.timestamp - MAX_AGE))));
        // +1 second reverts — but the first issue bound the epoch, so move to
        // the next epoch for the stale case
        _nextEpoch();
        vm.expectRevert(
            abi.encodeWithSelector(
                IGpuOracle.StaleObservation.selector,
                uint64(block.timestamp - MAX_AGE - 1),
                uint64(block.timestamp - MAX_AGE)
            )
        );
        issuance.issue(H100, 1e18, alice, _updateDataFor(_reportAt(H100, 25_000, uint64(block.timestamp - MAX_AGE - 1))));
    }

    function test_futureTimestampReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IGpuOracle.FutureObservation.selector, uint64(block.timestamp + 1), block.timestamp
            )
        );
        issuance.issue(H100, 1e18, alice, _updateDataFor(_reportAt(H100, 25_000, uint64(block.timestamp + 1))));
    }

    function test_secondPriceSameEpochReverts_equivocation() public {
        // first consumer binds the epoch's reportHash for the GPU: a second
        // issuance at a DIFFERENT price in the same epoch is an equivocation
        // and reverts — the migration's core "one price per epoch" guarantee
        vm.prank(alice);
        issuance.issue(H100, 1e18, alice, _updateData(H100, 25_000));
        IGpuOracle.Report memory r2 = _report(H100, 26_000);
        vm.expectRevert(
            abi.encodeWithSelector(IGpuOracle.EpochAlreadyBound.selector, oracle.lastConsumedReportHash(H100), oracle.reportHash(r2, _sign(r2)))
        );
        issuance.issue(H100, 1e18, alice, _updateDataFor(r2));
    }

    function test_sameReportReconsumedIsIdempotent() public {
        // byte-identical updateData (same signature): consume dedupes, the
        // epoch binding matches, issuance proceeds at the same price
        bytes memory updateData = _updateData(H100, 25_000);
        vm.prank(alice);
        issuance.issue(H100, 1e18, alice, updateData);
        vm.prank(alice);
        (uint256 base, uint256 fee) = issuance.issue(H100, 1e18, alice, updateData);
        assertEq(base, 2_500_000);
        // 50 bps of base, rounded up: 2_500_000 * 50 / 10_000 = 12_500
        assertEq(fee, 12_500);
    }

    function test_nextEpochRebinds() public {
        vm.prank(alice);
        issuance.issue(H100, 1e18, alice, _updateData(H100, 25_000));
        _nextEpoch();
        // a fresh report at a new price prices the next epoch's issuance
        vm.prank(alice);
        (uint256 base,) = issuance.issue(H100, 1e18, alice, _updateData(H100, 26_500));
        assertEq(base, 2_650_000);
        assertEq(oracle.lastConsumedPrice(H100), 26_500);
    }

    function test_pauseBlocksIssue() public {
        issuance.pause();
        vm.prank(alice);
        vm.expectRevert();
        issuance.issue(H100, 1e18, alice, _updateData(H100, 25_000));
        issuance.unpause();
        vm.prank(alice);
        issuance.issue(H100, 1e18, alice, _updateData(H100, 25_000));
    }

    function test_create2Determinism() public {
        address t1 = issuance.tokenOf(H100);
        vm.expectRevert(GPUIssuance.GpuAlreadyExists.selector);
        issuance.createGpu(H100, "x", "x", 0, 3000, 60);
        // salt == gpuId: recreated independently it would land at same address
        GPUToken tok = GPUToken(t1);
        assertEq(tok.issuer(), address(issuance));
        assertEq(tok.gpuId(), H100);
    }

    function test_principalAccountingUntouchedByTransfers() public {
        vm.prank(alice);
        issuance.issue(H100, 100e18, alice, _updateData(H100, 25_000));
        uint256 c0 = pol.principalContributed(H100);
        // alice transfers tokens around; accounting is cumulative, untouched
        GPUToken tok = GPUToken(issuance.tokenOf(H100));
        vm.prank(alice);
        tok.transfer(address(0xBEEF), 1e18);
        assertEq(pol.principalContributed(H100), c0);
    }

    function test_fuzz_reserveCoversExactOracleValue(uint256 amount, uint256 price) public {
        amount = bound(amount, 1, 1_000_000e18);
        price = bound(price, 1, 100_000); // $0.0001 .. $10.00
        underlying.mint(alice, 100_000_000e6);
        // fund alice for worst-case cost at max price (base <= 1e13 + fee)
        vm.startPrank(alice);
        underlying.approve(address(gusd), type(uint256).max);
        gusd.mint(20_000_000e6, alice); // covers base<=1e13 + fee
        gusd.approve(address(issuance), type(uint256).max);
        vm.stopPrank();
        uint256 contributedBefore = pol.principalContributed(H100);
        uint256 custodyBefore = gusd.balanceOf(address(pol));
        vm.prank(alice);
        (uint256 base,) = issuance.issue(H100, amount, alice, _updateData(H100, price));
        // cumulative accounting grows by exactly base; custody matches (the
        // principal sits in the vault as bid capacity in this minimal rig)
        assertEq(pol.principalContributed(H100), contributedBefore + base);
        assertEq(gusd.balanceOf(address(pol)), custodyBefore + base);
        assertEq(gusd.balanceOf(address(issuance)), 0);
        // reserve >= exact real-world value: amount * price / 1e16 (floor would underpay)
        uint256 exact = Math__mulDiv(amount, price, 1e16);
        assertGe(base, exact);
        assertLe(base, exact + price); // ceil adds < 1 unit of price scale
    }

    // ------------------------------------- composition divisor (derived)

    function test_compositionDivisorDerivedFromPriceScale() public {
        // derived from the coordination-fixed PRICE_SCALE, not a re-declared literal
        assertEq(issuance.compositionDivisor(), 1e18 * issuance.PRICE_SCALE() / 1e6);
        assertEq(issuance.compositionDivisor(), 1e16);
    }

    // ------------------------------------- quoteIssue == issue guards

    function test_quoteIssue_revertsOnUnsignedGpu() public {
        issuance.createGpu(H200, "H200 141GB GPU-hour", "H200", 50, 3000, 60);
        issuance.setIssuanceEnabled(H200, true);
        // known + enabled, but the report is for the WRONG GPU
        vm.expectRevert(
            abi.encodeWithSelector(IGpuOracle.GpuMismatch.selector, H200, H100)
        );
        issuance.quoteIssue(H200, 1e18, _updateData(H100, 25_000));
    }

    function test_quoteIssue_revertsWhenDisabled() public {
        issuance.setIssuanceEnabled(H100, false);
        vm.expectRevert(GPUIssuance.IssuanceDisabled.selector);
        issuance.quoteIssue(H100, 1e18, _updateData(H100, 25_000));
    }

    function test_quoteIssue_stalenessBoundaryMatchesExecution() public {
        // exactly maxObservationAge: quote fine
        (uint256 base,,) = issuance.quoteIssue(H100, 1e18, _updateDataFor(_reportAt(H100, 25_000, uint64(block.timestamp - MAX_AGE))));
        assertEq(base, 2_500_000);
        // +1 second: quote reverts exactly like issue does
        vm.expectRevert(
            abi.encodeWithSelector(
                IGpuOracle.StaleObservation.selector,
                uint64(block.timestamp - MAX_AGE - 1),
                uint64(block.timestamp - MAX_AGE)
            )
        );
        issuance.quoteIssue(H100, 1e18, _updateDataFor(_reportAt(H100, 25_000, uint64(block.timestamp - MAX_AGE - 1))));
    }

    function test_quoteIssue_revertsOnFutureTimestamp() public {
        vm.expectRevert(
            abi.encodeWithSelector(IGpuOracle.FutureObservation.selector, uint64(block.timestamp + 1), block.timestamp)
        );
        issuance.quoteIssue(H100, 1e18, _updateDataFor(_reportAt(H100, 25_000, uint64(block.timestamp + 1))));
    }

    function test_quoteIssue_revertsOnZeroAmount() public {
        vm.expectRevert(GPUIssuance.ZeroAmount.selector);
        issuance.quoteIssue(H100, 0, _updateData(H100, 25_000));
    }

    // ------------------------------------- reference sqrt (report-verified)

    function test_priceSqrtPriceX96_workedExample() public {
        // sqrt(2.5e-12) * 2^96 for price 25_000 — the pool starting price
        // Deploy uses (inverted when gUSD is currency0)
        assertEq(issuance.priceSqrtPriceX96(25_000), 125_270_724_187_523_965_593_206);
    }

    function test_priceSqrtPriceX96_isExactFloorSqrtOfRadicand() public {
        uint256 s = issuance.priceSqrtPriceX96(25_000);
        uint256 radicand = Math.mulDiv(25_000, 1 << 192, 1e16);
        // floor sqrt: s^2 <= radicand < (s+1)^2
        assertLe(s * s, radicand);
        assertGt((s + 1) * (s + 1), radicand);
    }

    function test_priceSqrtPriceX96_monotonicInPrice() public {
        uint256 at25 = issuance.priceSqrtPriceX96(25_000);
        assertGt(issuance.priceSqrtPriceX96(30_000), at25);
    }

    function test_reportSqrtPriceX96_appliesFullAcceptanceSet() public {
        // verified report -> reference sqrt
        IGpuOracle.Report memory r = _report(H100, 25_000);
        assertEq(issuance.reportSqrtPriceX96(H100, r, _sign(r)), issuance.priceSqrtPriceX96(25_000));
        // a stale observation reverts — nothing is ever placed at an
        // unverified reference
        IGpuOracle.Report memory stale = _reportAt(H100, 25_000, uint64(block.timestamp - MAX_AGE - 1));
        vm.expectRevert(
            abi.encodeWithSelector(
                IGpuOracle.StaleObservation.selector,
                stale.observedAt,
                uint64(block.timestamp - MAX_AGE)
            )
        );
        issuance.reportSqrtPriceX96(H100, stale, _sign(stale));
    }

    // ------------------------------------- in-swap backstop entry points

    function test_quoteIssueCredited_matchesQuoteIssue() public view {
        (uint256 b1, uint256 f1, uint256 t1) = issuance.quoteIssueCredited(H100, 100e18, _updateData(H100, 25_000));
        (uint256 b2, uint256 f2, uint256 t2) = issuance.quoteIssue(H100, 100e18, _updateData(H100, 25_000));
        assertEq(b1, b2);
        assertEq(f1, f2);
        assertEq(t1, t2);
    }

    function test_issueCredited_isHookOnly() public {
        vm.prank(alice);
        vm.expectRevert(); // the hook is address(0)-ish in this minimal rig
        issuance.issueCredited(H100, 1e18, alice, 3_000_000, _updateData(H100, 25_000));
    }

    function test_quoteIssueCredited_revertsWhenDisabled() public {
        issuance.setIssuanceEnabled(H100, false);
        vm.expectRevert(GPUIssuance.IssuanceDisabled.selector);
        issuance.quoteIssueCredited(H100, 1e18, _updateData(H100, 25_000));
    }

    function test_quoteIssueCredited_revertsOnStaleReport() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IGpuOracle.StaleObservation.selector,
                uint64(block.timestamp - MAX_AGE - 1),
                uint64(block.timestamp - MAX_AGE)
            )
        );
        issuance.quoteIssueCredited(
            H100, 1e18, _updateDataFor(_reportAt(H100, 25_000, uint64(block.timestamp - MAX_AGE - 1)))
        );
    }

    function test_quoteIssueCredited_revertsOnOldEpoch() public {
        IGpuOracle.Report memory r = _report(H100, 25_000);
        bytes memory updateData = _updateDataFor(r);
        _nextEpoch();
        vm.expectRevert(
            abi.encodeWithSelector(IGpuOracle.UnknownGpuEpoch.selector, oracle.currentEpoch(), r.epoch)
        );
        issuance.quoteIssueCredited(H100, 1e18, updateData);
    }

    function Math__mulDiv(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        return a * b / d;
    }
}
