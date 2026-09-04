// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {GUSD} from "../../src/GUSD.sol";
import {GPUIssuance} from "../../src/GPUIssuance.sol";
import {GPUToken} from "../../src/GPUToken.sol";
import {GpuId} from "../../src/libraries/GpuId.sol";
import {MockGPUPriceOracle} from "../../src/oracle/MockGPUPriceOracle.sol";
import {IGPUPriceOracle} from "../../src/oracle/IGPUPriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract GPUIssuanceTest is Test {
    MockERC20 internal usdc;
    GUSD internal gusd;
    MockGPUPriceOracle internal oracle;
    address internal ledger = makeAddr("ledger");
    GPUIssuance internal issuance;
    address internal alice = makeAddr("alice");

    bytes32 internal constant H100 = bytes32(bytes("H100_SXM_80GB"));

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        gusd = new GUSD(IERC20(address(usdc)), address(this));
        oracle = new MockGPUPriceOracle(address(this));
        issuance = new GPUIssuance(IERC20(address(gusd)), IGPUPriceOracle(address(oracle)), ledger, address(this));
        gusd.setRevenueSink(ledger); // any sink ok for tests
        issuance.createGpu(H100, "H100 SXM 80GB GPU-hour", "H100", 50, 3000, 60);
        issuance.setIssuanceEnabled(H100, true);
        oracle.setPrice(H100, 25_000, block.timestamp); // $2.50/GPU-hour
        // fund alice with gUSD
        usdc.mint(alice, 1_000_000e6);
        vm.startPrank(alice);
        usdc.approve(address(gusd), type(uint256).max);
        gusd.mintUSDC(10_000e6, alice);
        gusd.approve(address(issuance), type(uint256).max);
        vm.stopPrank();
    }

    function test_workedExample_100H100_at_2_50() public {
        vm.prank(alice);
        (uint256 base, uint256 fee) = issuance.issue(H100, 100e18, alice);
        // base = 100e18 * 25_000 / 1e16 = 250_000_000 = 250.000000 gUSD
        assertEq(base, 250_000_000);
        // fee = ceil(250_000_000 * 50 / 10_000) = 1_250_000 = 1.25 gUSD
        assertEq(fee, 1_250_000);
        assertEq(GPUToken(issuance.tokenOf(H100)).balanceOf(alice), 100e18);
        assertEq(issuance.gpuReserve(H100), 250_000_000);
        assertEq(gusd.balanceOf(ledger), 1_250_000);
        // exact accounting: contract holds reserve, ledger holds fee
        assertEq(gusd.balanceOf(address(issuance)), 250_000_000);
    }

    function test_quoteMatchesCharge() public {
        (uint256 qb, uint256 qf, uint256 qt) = issuance.quoteIssue(H100, 100e18);
        assertEq(qb, 250_000_000);
        assertEq(qf, 1_250_000);
        assertEq(qt, 251_250_000);
        vm.prank(alice);
        (uint256 base, uint256 fee) = issuance.issue(H100, 100e18, alice);
        assertEq(base, qb);
        assertEq(fee, qf);
    }

    function test_ceilOnIndivisibleBase() public {
        // 1 wei of H100 at 2.5000: base = 1e18*25000/1e16 = 2500 exactly.
        // 3 wei: 7500. Non-divisible: 1e18/7 wei -> ceil.
        uint256 amount = (1e18 - 1) / 7 + 1;
        vm.prank(alice);
        (uint256 base,) = issuance.issue(H100, amount, alice);
        // amount*price/1e16 = 357142.857... -> ceil 357143
        assertEq(base, 357_143);
        assertEq(issuance.gpuReserve(H100), 357_143);
    }

    function test_ceilOnFee() public {
        // fee 1 bps on base 101 -> ceil(101*1/1e4)=1... use fee 50 on base 101 -> 1
        issuance.setIssuanceFee(H100, 50);
        uint256 amount = 1e14; // base = 1e14*25000/1e16 = 250
        vm.prank(alice);
        (, uint256 fee) = issuance.issue(H100, amount, alice);
        assertEq(fee, 2); // ceil(250*50/1e4) = ceil(1.25) = 2
    }

    function test_unknownGpuReverts() public {
        vm.expectRevert(GPUIssuance.UnknownGpuId.selector);
        issuance.issue(bytes32(bytes("FAKE_GPU")), 1e18, alice);
    }

    function test_disabledGpuReverts() public {
        issuance.setIssuanceEnabled(H100, false);
        vm.expectRevert(GPUIssuance.IssuanceDisabled.selector);
        issuance.issue(H100, 1e18, alice);
    }

    function test_zeroPriceReverts() public {
        oracle.setPrice(H100, 0, block.timestamp);
        vm.expectRevert(GPUIssuance.OraclePriceZero.selector);
        issuance.issue(H100, 1e18, alice);
    }

    function test_stalenessBoundary() public {
        // exactly maxOracleStaleness passes
        oracle.setPrice(H100, 25_000, block.timestamp - issuance.maxOracleStaleness());
        vm.prank(alice);
        issuance.issue(H100, 1e18, alice);
        // +1 second reverts
        oracle.setPrice(H100, 25_000, block.timestamp - issuance.maxOracleStaleness() - 1);
        vm.expectRevert(GPUIssuance.OracleStale.selector);
        vm.prank(alice);
        issuance.issue(H100, 1e18, alice);
    }

    function test_futureTimestampReverts() public {
        oracle.setPrice(H100, 25_000, block.timestamp + 1);
        vm.expectRevert(GPUIssuance.OracleFutureTimestamp.selector);
        vm.prank(alice);
        issuance.issue(H100, 1e18, alice);
    }

    function test_pauseBlocksIssue() public {
        issuance.pause();
        vm.prank(alice);
        vm.expectRevert();
        issuance.issue(H100, 1e18, alice);
        issuance.unpause();
        vm.prank(alice);
        issuance.issue(H100, 1e18, alice);
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

    function test_reserveNeverDecreasesOnTrades() public {
        vm.prank(alice);
        issuance.issue(H100, 100e18, alice);
        uint256 r0 = issuance.gpuReserve(H100);
        // alice transfers tokens around; reserve untouched
        GPUToken tok = GPUToken(issuance.tokenOf(H100));
        vm.prank(alice);
        tok.transfer(address(0xBEEF), 1e18);
        assertEq(issuance.gpuReserve(H100), r0);
    }

    function test_fuzz_reserveCoversExactOracleValue(uint256 amount, uint256 price) public {
        amount = bound(amount, 1, 1_000_000e18);
        price = bound(price, 1, 100_000); // $0.0001 .. $10.00
        oracle.setPrice(H100, price, block.timestamp);
        usdc.mint(alice, 100_000_000e6);
        // fund alice for worst-case cost at max price (base <= 1e13 + fee)
        vm.startPrank(alice);
        usdc.approve(address(gusd), type(uint256).max);
        gusd.mintUSDC(20_000_000e6, alice); // covers base<=1e13 + fee
        gusd.approve(address(issuance), type(uint256).max);
        vm.stopPrank();
        uint256 gusdBefore = gusd.balanceOf(address(issuance));
        vm.prank(alice);
        (uint256 base,) = issuance.issue(H100, amount, alice);
        assertEq(issuance.gpuReserve(H100), gusdBefore + base);
        // reserve >= exact real-world value: amount * price / 1e16 (floor would underpay)
        uint256 exact = Math__mulDiv(amount, price, 1e16);
        assertGe(base, exact);
        assertLe(base, exact + price); // ceil adds < 1 unit of price scale
    }

    function Math__mulDiv(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        return a * b / d;
    }
}
