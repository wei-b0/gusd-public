// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {OracleReports} from "../utils/OracleReports.sol";
import {GUSD} from "../../src/GUSD.sol";
import {sgUSD} from "../../src/sgUSD.sol";
import {RevenueLedger} from "../../src/RevenueLedger.sol";
import {GpuPerpEngine} from "../../src/GpuPerpEngine.sol";
import {IGpuPerpEngine} from "../../src/interfaces/IGpuPerpEngine.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PerpBase} from "./PerpLifecycle.t.sol";

/// @notice Liquidity-crunch safety: settlement NEVER reverts for vault
///         liquidity; the reservation stops ordinary redemptions from
///         front-running claims; claims pay partially and complete later.
contract PerpCrunchTest is PerpBase {
    function setUp() public {
        _deployOracle();
        underlying = new MockERC20("USD Coin", "USDC", 6);
        gusd = new GUSD(IERC20(address(underlying)), address(this));
        sg = new sgUSD(IERC20(address(gusd)), address(this));
        ledger = new RevenueLedger(IERC20(address(gusd)), address(this));
        engine = new GpuPerpEngine(IERC20(address(gusd)), sg, oracle, address(ledger), address(this));
        sg.setPerpEngine(address(engine));
        sg.setEngineMaxWithdrawPerBlock(type(uint256).max);
        _mintGusd(address(this), 2_000_000e6);
        gusd.approve(address(sg), type(uint256).max);
        sg.seed(200_000e6); // deliberately thin LP capital
        _mintGusd(alice, 100_000e6);
        engine.createMarket(H100, _defaultParams());
    }

    function _mintGusd(address to, uint256 amt) internal {
        underlying.mint(to, amt);
        vm.startPrank(to);
        underlying.approve(address(gusd), type(uint256).max);
        gusd.mint(amt, to);
        vm.stopPrank();
    }

    function test_settlementNeverRevertsAndClaimPaysPartially() public {
        // Long 50k notional on 25k collateral at $2.00 (2x). Open fee 50 gUSD
        // (stored collateral 24_950e6). Price $4.00 → uPnL +50_000e6.
        _createAndExecute(
            alice, _order(H100, IGpuPerpEngine.OrderKind.MarketIncrease, true, 50_000e6, 25_000e6, 2_0000, 0), 2_0000
        );
        // Reservation is last-touch: at open (uPnL = 0 at entry) it pins nothing.
        assertEq(sg.perpReserved(), 0);

        // Full close at $4.00: released 24_950e6 + pnl 50_000e6 − closeFee
        // 50e6 = 74_900_000_000 — settlement is accounting only and cannot
        // revert; the released remainder (24_900e6) rides to the vault.
        _nextEpoch();
        uint256 orderId = _createOnly(_order(H100, IGpuPerpEngine.OrderKind.MarketDecrease, true, 0, 0, 4_0000, 0));
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(orderId, _updateData(H100, 4_0000));
        assertEq(engine.claimableOf(alice), 74_900_000_000);
        assertEq(gusd.balanceOf(address(sg)), 200_000e6 + 24_900e6); // released − closeFee
        _assertEngineBalance(0);

        // The reservation now pins the whole claimable, and ordinary
        // redemptions cannot strip the vault ahead of the trader.
        assertEq(sg.perpReserved(), 74_900_000_000);
        assertEq(sg.availableForRedemption(), 224_900e6 - 74_900_000_000);

        // Claim: drain the vault via a simulated run (LP exits) to force the
        // partial path.
        vm.prank(address(sg));
        gusd.transfer(bob, 200_000e6);
        vm.prank(alice);
        uint256 paid = engine.claim(type(uint256).max, alice);
        assertEq(paid, 24_900e6); // what the vault actually holds
        assertEq(engine.claimableOf(alice), 50_000_000_000); // remainder stays claimable
        assertEq(sg.perpReserved(), 50_000_000_000);

        // A later revenue-style top-up completes the claim (the vault itself
        // is empty — bob, who drained it, refills it).
        vm.prank(bob);
        gusd.transfer(address(sg), 50_000e6);
        vm.prank(alice);
        paid = engine.claim(type(uint256).max, alice);
        assertEq(paid, 50_000e6);
        assertEq(engine.totalClaimable(), 0);
        assertEq(sg.perpReserved(), 0);
    }

    function _createOnly(IGpuPerpEngine.OrderParams memory p) internal returns (uint256 orderId) {
        vm.startPrank(alice);
        gusd.approve(address(engine), type(uint256).max);
        orderId = engine.createOrder(p);
        vm.stopPrank();
    }

    function test_partialClaimHonorsPerBlockCap() public {
        _openLong(alice, 10_000e6, 1_000e6, 2_0000);
        uint256 closeId = _createOnly(_order(H100, IGpuPerpEngine.OrderKind.MarketDecrease, true, 0, 0, 2_0000, 0));
        _nextEpoch();
        vm.prank(bob);
        engine.executeOrder(closeId, _updateData(H100, 2_5000));
        // due = 990_000_000 + 2_500_000_000 − 10_000_000 (close fee)
        uint256 due = engine.claimableOf(alice);
        sg.setEngineMaxWithdrawPerBlock(1_000e6);
        vm.prank(alice);
        uint256 paid = engine.claim(type(uint256).max, alice);
        assertEq(paid, 1_000e6); // capped this block (clamped, never reverted)
        assertEq(engine.claimableOf(alice), due - 1_000e6);
        // Next block the cap resets: another 1_000e6 pays, then the cap is
        // lifted and the remainder completes.
        vm.roll(block.number + 1);
        vm.prank(alice);
        paid = engine.claim(type(uint256).max, alice);
        assertEq(paid, 1_000e6);
        sg.setEngineMaxWithdrawPerBlock(type(uint256).max);
        vm.prank(alice);
        paid = engine.claim(type(uint256).max, alice);
        assertEq(paid, due - 2_000e6);
        assertEq(engine.totalClaimable(), 0);
    }
}