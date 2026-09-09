// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {GUSD} from "../../src/GUSD.sol";
import {RevenueLedger} from "../../src/RevenueLedger.sol";
import {GPUIssuance} from "../../src/GPUIssuance.sol";
import {GPUMarketLiquidity} from "../../src/GPUMarketLiquidity.sol";
import {MockGPUPriceOracle} from "../../src/oracle/MockGPUPriceOracle.sol";
import {IGPUPriceOracle} from "../../src/oracle/IGPUPriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice GPUMarketLiquidity unit suite: the vault is pure two-sided
///         inventory + provenance. Principal arrives only from issuance
///         (notePrincipal) and is bid capacity immediately; GPU inventory is
///         booked hook-only and leaves only to the PoolManager. Band geometry
///         is deleted — fill-price-in-[bid,ask] properties live in
///         GPUHook.t.sol; this suite pins custody, provenance, and gates.
contract GPUMarketLiquidityTest is Test, Deployers {
    MockERC20 internal underlying;
    GUSD internal gusd;
    MockGPUPriceOracle internal oracle;
    GPUIssuance internal issuance;
    GPUMarketLiquidity internal vault;
    address internal ledger;
    address internal hookProxy; // the vault's hook gate is address-equality
    address internal gpuToken;
    address internal seller = makeAddr("seller");

    bytes32 internal constant GPU_ID = bytes32(bytes("H100_SXM_80GB"));
    bytes32 internal constant GENESIS_ID = bytes32(bytes("GENESIS_GPU"));
    uint256 internal constant PRICE = 25_000; // $2.50/GPU-hour, 4-dec

    function setUp() public {
        vm.warp(1_000_000);
        deployFreshManagerAndRouters();
        underlying = new MockERC20("USD Coin", "USDC", 6);
        gusd = new GUSD(IERC20(address(underlying)), address(this));
        ledger = address(new RevenueLedger(IERC20(address(gusd)), address(this)));
        oracle = new MockGPUPriceOracle(address(this));
        vault = new GPUMarketLiquidity(IERC20(address(gusd)), address(manager), address(this));
        issuance = new GPUIssuance(
            IERC20(address(gusd)), IGPUPriceOracle(address(oracle)), ledger, address(vault), address(this)
        );
        hookProxy = makeAddr("hookProxy");
        vault.setRefs(address(issuance), hookProxy);

        gusd.setRevenueSink(ledger);
        RevenueLedger(ledger).setVault(makeAddr("sgusdVault"));
        RevenueLedger(ledger).setTreasury(makeAddr("treasury"));

        _createGpu(GPU_ID, "H100 SXM 80GB", "H100");
        gpuToken = issuance.tokenOf(GPU_ID);
    }

    function _createGpu(bytes32 id, string memory name, string memory symbol) internal {
        issuance.createGpu(id, name, symbol, 50, 3000, 60);
        issuance.setIssuanceEnabled(id, true);
        oracle.setPrice(id, PRICE, block.timestamp);
    }

    function _issueTo(address to, bytes32 id, uint256 amount) internal returns (uint256 base) {
        uint256 fee;
        (base, fee,) = issuance.quoteIssue(id, amount);
        deal(address(gusd), to, base + fee);
        vm.startPrank(to);
        gusd.approve(address(issuance), type(uint256).max);
        issuance.issue(id, amount, to);
        vm.stopPrank();
    }

    // --------------------------------------------------------------- tests

    /// Provenance: primary issuance capitalizes the vault as bid capacity
    /// immediately — no staging phase — and is counted exactly once.
    function test_notePrincipal_capitalizesBidCapacity() public {
        uint256 ledger0 = gusd.balanceOf(ledger);
        (uint256 base, uint256 fee,) = issuance.quoteIssue(GPU_ID, 10e18);
        _issueTo(seller, GPU_ID, 10e18);

        assertEq(vault.bidInventoryGusd(GPU_ID), base, "principal is bid capacity");
        assertEq(vault.principalContributed(GPU_ID), base, "counted exactly once");
        assertEq(vault.totalBidGusd(), base, "aggregate");
        assertEq(gusd.balanceOf(address(vault)), base, "custody 1:1");
        assertEq(gusd.balanceOf(address(issuance)), 0, "issuance holds no gUSD");
        assertEq(gusd.balanceOf(ledger) - ledger0, fee, "fee to ledger");
        assertEq(IERC20(gpuToken).balanceOf(seller), 10e18, "tokens to buyer");
    }

    /// notePrincipal guards: issuance-only, non-zero, custody-backed (the
    /// vault books nothing it did not receive).
    function test_notePrincipal_guards() public {
        vm.prank(makeAddr("eoa"));
        vm.expectRevert(GPUMarketLiquidity.OnlyIssuance.selector);
        vault.notePrincipal(GPU_ID, 1);

        vm.prank(address(issuance));
        vm.expectRevert(GPUMarketLiquidity.ZeroAmount.selector);
        vault.notePrincipal(GPU_ID, 0);

        // issuance claims principal it never transferred: custody reverts
        vm.prank(address(issuance));
        vm.expectRevert(GPUMarketLiquidity.CustodyBacked.selector);
        vault.notePrincipal(GPU_ID, 100);
    }

    /// noteGpu guards: hook-only booking of ask inventory, custody-backed.
    /// An unknown gpuId's token lookup hits address(0): bare revert.
    function test_noteGpu_guardsAndBooking() public {
        vm.prank(makeAddr("eoa"));
        vm.expectRevert(GPUMarketLiquidity.OnlyHook.selector);
        vault.noteGpu(GPU_ID, 1e18);

        vm.prank(hookProxy);
        vm.expectRevert(GPUMarketLiquidity.ZeroAmount.selector);
        vault.noteGpu(GPU_ID, 0);

        // claiming GPU the vault does not hold: custody reverts
        vm.prank(hookProxy);
        vm.expectRevert(GPUMarketLiquidity.CustodyBacked.selector);
        vault.noteGpu(GPU_ID, 1e18);

        deal(gpuToken, address(vault), 5e18);
        vm.prank(hookProxy);
        vault.noteGpu(GPU_ID, 5e18);
        assertEq(vault.askInventoryGpu(GPU_ID), 5e18, "booked");
        assertEq(IERC20(gpuToken).balanceOf(address(vault)), 5e18, "custody 1:1");
    }

    /// pullGpuToManager: hook-only drain of ask inventory straight to the PM
    /// (the hook settles it inside the lock to cover its delivery debt).
    function test_pullGpuToManager() public {
        deal(gpuToken, address(vault), 5e18);
        vm.prank(hookProxy);
        vault.noteGpu(GPU_ID, 5e18);

        vm.prank(makeAddr("eoa"));
        vm.expectRevert(GPUMarketLiquidity.OnlyHook.selector);
        vault.pullGpuToManager(GPU_ID, 1e18);

        vm.prank(hookProxy);
        vm.expectRevert(GPUMarketLiquidity.UnknownGpuId.selector);
        vault.pullGpuToManager(bytes32(bytes("UNKNOWN")), 1);

        vm.prank(hookProxy);
        vm.expectRevert(GPUMarketLiquidity.InsufficientAskInventory.selector);
        vault.pullGpuToManager(GPU_ID, 5e18 + 1);

        vm.prank(hookProxy);
        vault.pullGpuToManager(GPU_ID, 2e18);
        assertEq(IERC20(gpuToken).balanceOf(address(manager)), 2e18, "PM received");
        assertEq(vault.askInventoryGpu(GPU_ID), 3e18, "inventory decremented");
        assertEq(IERC20(gpuToken).balanceOf(address(vault)), 3e18, "custody 1:1");
    }

    /// pullGusdToManager: hook-only drain of bid inventory; the per-id mapping
    /// and the aggregate both decrement with the balance.
    function test_pullGusdToManager() public {
        _issueTo(seller, GPU_ID, 10e18);

        vm.prank(makeAddr("eoa"));
        vm.expectRevert(GPUMarketLiquidity.OnlyHook.selector);
        vault.pullGusdToManager(GPU_ID, 1);

        uint256 over = vault.bidInventoryGusd(GPU_ID) + 1; // hoist: the arg
        // staticcall must not be the call expectRevert arms on
        vm.prank(hookProxy);
        vm.expectRevert(GPUMarketLiquidity.InsufficientBidInventory.selector);
        vault.pullGusdToManager(GPU_ID, over);

        uint256 bid0 = vault.bidInventoryGusd(GPU_ID);
        vm.prank(hookProxy);
        vault.pullGusdToManager(GPU_ID, bid0 / 2);
        assertEq(gusd.balanceOf(address(manager)), bid0 / 2, "PM received");
        assertEq(vault.bidInventoryGusd(GPU_ID), bid0 - bid0 / 2, "mapped decremented");
        assertEq(vault.totalBidGusd(), bid0 - bid0 / 2, "aggregate decremented");
        assertEq(gusd.balanceOf(address(vault)), bid0 - bid0 / 2, "custody 1:1");
    }

    /// creditBidFromTrade: the hook settles absorbed gUSD proceeds into the
    /// vault as bid capacity. Provenance: principal is NOT re-counted — it
    /// grew only through issuance (compare GPUHook fill tests).
    function test_creditBidFromTrade() public {
        _issueTo(seller, GPU_ID, 10e18);
        uint256 principal0 = vault.principalContributed(GPU_ID);
        uint256 bid0 = vault.bidInventoryGusd(GPU_ID);

        deal(address(gusd), hookProxy, 1_000e6);
        vm.startPrank(hookProxy);
        gusd.approve(address(vault), type(uint256).max);
        vault.creditBidFromTrade(GPU_ID, 400e6);
        vm.stopPrank();

        assertEq(vault.bidInventoryGusd(GPU_ID), bid0 + 400e6, "bid credited");
        assertEq(vault.totalBidGusd(), bid0 + 400e6, "aggregate");
        assertEq(vault.principalContributed(GPU_ID), principal0, "principal NOT re-counted");
        assertEq(gusd.balanceOf(address(vault)), bid0 + 400e6, "custody 1:1");

        vm.prank(hookProxy);
        vm.expectRevert(GPUMarketLiquidity.ZeroAmount.selector);
        vault.creditBidFromTrade(GPU_ID, 0);

        vm.prank(makeAddr("eoa"));
        vm.expectRevert(GPUMarketLiquidity.OnlyHook.selector);
        vault.creditBidFromTrade(GPU_ID, 1);
    }

    /// Wiring: one-shot, zero-checked, owner-only. Custody gates close on
    /// address inequality, so an unwired vault can never be driven.
    function test_setRefsOneShot() public {
        address nonOwner = makeAddr("nonOwner");
        vm.prank(nonOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nonOwner));
        vault.setRefs(address(2), address(3));

        vm.expectRevert(GPUMarketLiquidity.AlreadySet.selector);
        vault.setRefs(address(issuance), hookProxy);

        GPUMarketLiquidity fresh = new GPUMarketLiquidity(IERC20(address(gusd)), address(manager), address(this));
        vm.expectRevert(GPUMarketLiquidity.ZeroAddress.selector);
        fresh.setRefs(address(0), address(2));
        vm.expectRevert(GPUMarketLiquidity.ZeroAddress.selector);
        fresh.setRefs(address(2), address(0));
        fresh.setRefs(address(issuance), hookProxy);
        assertEq(fresh.issuance(), address(issuance), "issuance wired");
        assertEq(fresh.hook(), hookProxy, "hook wired");
    }

    /// Structural: the vault pre-approves nothing. It pushes via safeTransfer
    /// (hook-gated pulls) and pulls gUSD via transferFrom from the hook only —
    /// no open drain surface exists anywhere.
    function test_noApprovals() public {
        assertEq(IERC20(gpuToken).allowance(address(vault), address(manager)), 0, "no GPU approval");
        assertEq(gusd.allowance(address(vault), address(manager)), 0, "no gUSD approval");
        assertEq(gusd.allowance(address(vault), hookProxy), 0, "no hook approval");
        assertEq(IERC20(gpuToken).allowance(address(vault), hookProxy), 0, "no GPU approval to hook");
    }

    /// Donations strand outside mapped inventory: balance >= mapped sums, and
    /// pulls are capped by the mapping, never by the balance.
    function test_donationsStrand() public {
        _issueTo(seller, GPU_ID, 10e18);
        deal(address(gusd), address(vault), gusd.balanceOf(address(vault)) + 77e6);

        assertGt(gusd.balanceOf(address(vault)), vault.totalBidGusd(), "donation unmapped");
        uint256 over = vault.bidInventoryGusd(GPU_ID) + 1; // hoist: see pull test
        vm.prank(hookProxy);
        vm.expectRevert(GPUMarketLiquidity.InsufficientBidInventory.selector);
        vault.pullGusdToManager(GPU_ID, over);
    }

    /// Fuzz: principal across multiple GPU ids maps per-id; the aggregate and
    /// the 1:1 custody equation hold for arbitrary split sequences.
    function test_fuzz_multiGpuCustody(uint128 a, uint128 b) public {
        a = uint128(bound(uint256(a), 1e18, 100e18));
        b = uint128(bound(uint256(b), 1e18, 100e18));
        _createGpu(GENESIS_ID, "Genesis GPU", "GGPU");

        (uint256 baseA,,) = issuance.quoteIssue(GPU_ID, a);
        (uint256 baseB,,) = issuance.quoteIssue(GENESIS_ID, b);
        _issueTo(seller, GPU_ID, a);
        _issueTo(seller, GENESIS_ID, b);

        assertEq(vault.bidInventoryGusd(GPU_ID), baseA, "per-id map A");
        assertEq(vault.bidInventoryGusd(GENESIS_ID), baseB, "per-id map B");
        assertEq(vault.totalBidGusd(), baseA + baseB, "aggregate");
        assertEq(gusd.balanceOf(address(vault)), baseA + baseB, "custody 1:1");
        assertEq(vault.principalContributed(GPU_ID), baseA, "provenance A");
        assertEq(vault.principalContributed(GENESIS_ID), baseB, "provenance B");
    }
}
