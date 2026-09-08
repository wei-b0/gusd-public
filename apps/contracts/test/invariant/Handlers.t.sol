// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {GPUIssuance} from "../../src/GPUIssuance.sol";
import {GPUToken} from "../../src/GPUToken.sol";
import {GPUHook} from "../../src/hooks/GPUHook.sol";

library H100Id {
    bytes32 internal constant H100 = bytes32(bytes("H100_SXM_80GB"));

    function id() internal pure returns (bytes32) {
        return H100;
    }
}

using PoolIdLibrary for PoolKey;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Interface the handlers use to reach the shared invariant world.
interface IWorld {
    function underlying() external view returns (address);
    function gusd() external view returns (address);
    function issuance() external view returns (address);
    function h100() external view returns (address);
    function ledger() external view returns (address);
    function oracle() external view returns (address);
    function hookT() external view returns (address);
    function actors(uint256) external view returns (address);
    function swapRouterT() external view returns (address);
    function marketLiquidityT() external view returns (address);
    function poolKey() external view returns (PoolKey memory);
    function recordIssuance(uint256 base, uint256 fee, uint256 minted) external;
    function recordHarvest(uint256 amount) external;
    function recordPolCollect(uint256 amount) external;
}

error NotWorld();

abstract contract HandlerBase is Test {
    IWorld internal immutable w;
    address[] internal actorCache;

    constructor(IWorld world) {
        w = world;
        for (uint256 i; i < 4; ++i) {
            actorCache.push(world.actors(i));
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actorCache[seed % actorCache.length];
    }
}

contract HandlerMintRedeem is HandlerBase {
    constructor(IWorld world) HandlerBase(world) {}

    function mint(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        amount = bound(amount, 1e6, 1_000_000e6);
        MockERC20Like(w.underlying()).mint(actor, amount);
        vm.startPrank(actor);
        MockERC20Like(w.underlying()).approve(w.gusd(), type(uint256).max);
        GusdLike(w.gusd()).mint(amount, actor);
        vm.stopPrank();
    }

    function redeem(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        uint256 bal = GusdLike(w.gusd()).balanceOf(actor);
        if (bal == 0) return;
        vm.prank(actor);
        GusdLike(w.gusd()).redeem(bound(amount, 1, bal), actor);
    }

    function transferGusd(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        uint256 bal = GusdLike(w.gusd()).balanceOf(from);
        if (bal == 0 || from == to) return;
        vm.prank(from);
        GusdLike(w.gusd()).transfer(to, bound(amount, 1, bal));
    }
}

interface MockERC20Like {
    function mint(address, uint256) external;
    function approve(address, uint256) external returns (bool);
}

interface GusdLike {
    function approve(address, uint256) external returns (bool);
    function mint(uint256, address) external returns (uint256);
    function redeem(uint256, address) external returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

contract HandlerIssuance is HandlerBase {
    constructor(IWorld world) HandlerBase(world) {}

    function issue(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        amount = bound(amount, 1, 1_000e18);
        GPUIssuance iss = GPUIssuance(w.issuance());
        (,, uint256 need) = iss.quoteIssue(H100Id.id(), amount);
        uint256 have = GusdLike(w.gusd()).balanceOf(actor);
        if (have < need) {
            uint256 deficit = need - have;
            MockERC20Like(w.underlying()).mint(actor, deficit);
            vm.startPrank(actor);
            MockERC20Like(w.underlying()).approve(w.gusd(), type(uint256).max);
            GusdLike(w.gusd()).mint(deficit, actor);
            GusdLike(w.gusd()).approve(w.issuance(), type(uint256).max);
            vm.stopPrank();
        }
        vm.prank(actor);
        (uint256 base, uint256 fee) = iss.issue(H100Id.id(), amount, actor);
        // ghosts live on the world; the fuzzer never targets it
        w.recordIssuance(base, fee, amount);
    }
}

/// @notice Drives the POL's permissionless surface: deploy pending principal,
///         recenter stale bands, collect fees. Every path is best-effort —
///         the honest no-op outcomes (defer, NothingToRecenter, stale
///         reference) revert or return false and the handler moves on.
contract HandlerLiquidity is HandlerBase {
    constructor(IWorld world) HandlerBase(world) {}

    function deployPending() external {
        try MarketLiquidityLike(w.marketLiquidityT()).deployPending(H100Id.id()) {} catch {}
    }

    function recenter(uint256 maxBands) external {
        try MarketLiquidityLike(w.marketLiquidityT()).recenter(H100Id.id(), bound(maxBands, 1, 10)) {} catch {}
    }

    /// @notice Sweep LP fees: gUSD -> revenue ledger, GPU -> ask inventory.
    ///         The world's revenue-conservation invariant tracks the ledger
    ///         delta (exact even for fees swept inside the call).
    function collect() external {
        uint256 before = _ledgerReceived();
        try MarketLiquidityLike(w.marketLiquidityT()).collect(H100Id.id()) {} catch {}
        uint256 delta = _ledgerReceived() - before;
        if (delta > 0) w.recordPolCollect(delta);
    }

    function _ledgerReceived() internal view returns (uint256) {
        address l = w.ledger();
        return GusdLike(w.gusd()).balanceOf(l) + RevenueLedgerLike(l).totalToVault() + RevenueLedgerLike(l).totalToTreasury();
    }
}

contract HandlerMarket is HandlerBase {
    constructor(IWorld world) HandlerBase(world) {}

    function swapGusdForGpu(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        amount = bound(amount, 1e6, 100_000e6);
        PoolKey memory key = w.poolKey();
        bool gIsC0 = Currency.unwrap(key.currency0) == w.gusd();
        if (GusdLike(w.gusd()).balanceOf(actor) < amount) {
            MockERC20Like(w.underlying()).mint(actor, amount);
            vm.startPrank(actor);
            MockERC20Like(w.underlying()).approve(w.gusd(), type(uint256).max);
            GusdLike(w.gusd()).mint(amount, actor);
            vm.stopPrank();
        }
        vm.startPrank(actor);
        GusdLike(w.gusd()).approve(w.swapRouterT(), type(uint256).max);
        PoolSwapTest(w.swapRouterT())
            .swap(
                key,
                SwapParams({
                zeroForOne: gIsC0,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: gIsC0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ""
            );
        vm.stopPrank();
    }

    function swapGpuForGusd(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        PoolKey memory key = w.poolKey();
        bool gIsC0 = Currency.unwrap(key.currency0) == w.gusd();
        GPUToken tok = GPUToken(w.h100());
        uint256 have = tok.balanceOf(actor);
        if (have == 0) return;
        amount = bound(amount, 1, have);
        vm.startPrank(actor);
        tok.approve(w.swapRouterT(), type(uint256).max);
        PoolSwapTest(w.swapRouterT())
            .swap(
                key,
                SwapParams({
                zeroForOne: !gIsC0,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: gIsC0 ? TickMath.MAX_SQRT_PRICE - 1 : TickMath.MIN_SQRT_PRICE + 1
            }),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ""
            );
        vm.stopPrank();
    }
}

contract HandlerGovernance is HandlerBase {
    constructor(IWorld world) HandlerBase(world) {}

    function setIssuanceFee(uint256 feeBps) external {
        GPUIssuance iss = GPUIssuance(w.issuance());
        iss.setIssuanceFee(H100Id.id(), uint16(bound(feeBps, 0, iss.MAX_ISSUANCE_FEE_BPS())));
    }

    function setSplit(uint256 bps) external {
        RevenueLedgerLike(w.ledger()).setSplit(uint16(bound(bps, 0, 10_000)));
    }

    function setPrice(uint256 price) external {
        OracleLike(w.oracle()).setPrice(H100Id.id(), bound(price, 1, 100_000), block.timestamp);
    }

    function distribute() external {
        if (RevenueLedgerLike(w.ledger()).pendingRevenue() > 0) RevenueLedgerLike(w.ledger()).distribute();
    }

    /// @notice Permissionless harvest of the canonical pool's accrued hook
    ///         trading fees into the ledger (0 = all pending). The world's
    ///         revenue-conservation invariant counts what moves here.
    function harvest() external {
        GPUHook h = GPUHook(w.hookT());
        PoolId pid = w.poolKey().toId();
        uint256 pending = h.pendingTradingFees(pid);
        h.harvestTradingFees(pid, 0);
        if (pending > 0) w.recordHarvest(pending);
    }
}

interface RevenueLedgerLike {
    function setSplit(uint16) external;
    function pendingRevenue() external view returns (uint256);
    function distribute() external;
    function totalToVault() external view returns (uint256);
    function totalToTreasury() external view returns (uint256);
}

interface MarketLiquidityLike {
    function deployPending(bytes32) external returns (bool);
    function recenter(bytes32, uint256) external returns (uint256);
    function collect(bytes32) external;
}

interface OracleLike {
    function setPrice(bytes32, uint256, uint256) external;
}
