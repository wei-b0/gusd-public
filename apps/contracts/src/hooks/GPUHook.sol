// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {ProtocolFeeLibrary} from "@uniswap/v4-core/src/libraries/ProtocolFeeLibrary.sol";
import {PoolWalk} from "../libraries/PoolWalk.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IHookStats} from "@uniswap/v4-periphery/interfaces/external/IHookStats.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IGPUIssuance} from "../interfaces/IGPUIssuance.sol";
import {IMarketLiquidity} from "../interfaces/IMarketLiquidity.sol";
import {IGPUPriceOracle} from "../oracle/IGPUPriceOracle.sol";

/// @title GPUHook — protocol market maker inside every canonical GPU/gUSD pool.
/// @notice Permissions: afterInitialize, beforeSwap, afterSwap (+ both swap
///         return-delta flags), mask 0x10CC. The hook reads the guarded oracle
///         INSIDE every swap, derives oracle-anchored bid/ask edges, simulates
///         the native book's walk to the edge (bounded, word-skipped), and
///         fills everything beyond the edge from GPUMarketLiquidity inventory
///         (POL) with GPUIssuance as the final in-swap backstop. One swap call
///         is the complete market. Stale oracle => the hook fills nothing.
/// @dev    Lifecycle: plan in beforeSwap (absorb the beyond-edge input),
///         realize in afterSwap (settle fills, return the output delta). The
///         plan is stateless: afterSwap recovers the absorbed amount from the
///         native swapDelta and re-derives every spend from a fresh guarded
///         oracle read — no transient state, safe under nested swaps.
contract GPUHook is IHooks, IHookStats, Ownable2Step {
    using PoolIdLibrary for PoolKey;
    using ProtocolFeeLibrary for uint16;
    using SafeERC20 for IERC20;

    uint16 public constant MAX_SPREAD_BPS = 5_000;
    uint16 public constant MAX_HOOK_FEE_BPS = 1_000;
    uint256 public constant DEFAULT_MAX_WALK_TICKS = 48;
    uint256 public constant DEFAULT_MAX_POL_NOTIONAL_GUSD = 1_000_000e6;
    uint256 public constant DEFAULT_PER_BLOCK_POL_CAP_GUSD = 5_000_000e6;
    uint256 public constant DEFAULT_MAX_ORACLE_STALENESS = 25 hours;

    struct PolParams {
        uint16 askBps;
        uint16 bidBps;
        uint16 polFeeBps;
    }

    struct PoolCtx {
        bool gIsC0;
        bool exactIn;
        bool zeroForOne;
        bool isBuy;
        bytes32 gpuId;
        address gpuToken;
    }

    /// @dev beforeSwap's decision, expressed as hook deltas: specified is
    ///      returned in the specified component, unspecified likewise.
    struct Plan {
        int128 deltaSpecified;
        int128 deltaUnspecified;
        bool revert_; // no capacity anywhere — the honest "market closed"
    }

    IPoolManager public immutable poolManager;
    address public immutable gUSD;
    IGPUIssuance public immutable issuance;
    IGPUPriceOracle public immutable oracle;
    address public immutable revenueLedger;
    IMarketLiquidity internal _vault;
    /// @dev Self-deployed helper holding the walk machinery — keeps the hook's
    ///      runtime under EIP-170 without external-library linking (which
    ///      would change `type(GPUHook).creationCode` and break CREATE2
    ///      address mining).
    PoolWalk internal immutable _poolWalk;

    uint16 public hookFeeBps; // native-leg fee; retired to 0 by default (R1)
    uint256 public maxOracleStaleness = DEFAULT_MAX_ORACLE_STALENESS;
    uint256 public maxWalkTicks = DEFAULT_MAX_WALK_TICKS;
    uint256 public maxPolNotionalGusd = DEFAULT_MAX_POL_NOTIONAL_GUSD;
    uint256 public perBlockPolCapGusd = DEFAULT_PER_BLOCK_POL_CAP_GUSD;
    bool public polPaused;

    mapping(PoolId => bytes32) public poolGpuId;
    mapping(bytes32 => PolParams) internal _polParams;
    mapping(uint256 => uint256) internal _polVolumeByBlock;

    uint256 public totalPolFeesGusd; // cumulative POL fee charged (stat)
    uint256 public totalPolNotionalGusd; // cumulative POL notional (stat)
    uint256 public totalHookFeesGusd; // cumulative hook fee charged in gUSD (stat)

    error NotPoolManager();
    error NotCanonicalPool();
    error PoolAlreadyRegistered();
    error FeeTooLarge();
    error FeeExceedsSwap();
    error PolPaused();
    error InvalidParams();
    error OraclePriceRange();
    error DeltaTooLarge();
    error InsufficientMarketCapacity();
    error HarvestExceedsPending();
    error SingleCurrencyPoolsOnly();
    error GpuMismatch();

    event PoolRegistered(PoolId indexed poolId, bytes32 indexed gpuId);
    event HookSwap(PoolId indexed id, address indexed sender, int128 amount0, int128 amount1, uint24 swapFee);
    event GpuFill(
        PoolId indexed poolId,
        bytes32 indexed gpuId,
        address indexed sender,
        bool isBuy,
        uint256 gpuAmount,
        uint256 gusdAmount,
        uint256 protocolFee,
        uint8 source
    );
    event PolParamsSet(bytes32 indexed gpuId, uint16 askBps, uint16 bidBps, uint16 polFeeBps);
    event PolPausedSet(bool paused);
    event PolCapsSet(uint256 maxPolNotionalGusd, uint256 perBlockPolCapGusd);
    event HookFeeBpsSet(uint16 oldFeeBps, uint16 newFeeBps);
    event MaxOracleStalenessSet(uint256 seconds_);
    event MaxWalkTicksSet(uint256 v);
    event PolFeeCharged(PoolId indexed poolId, bytes32 indexed gpuId, uint256 gusdFee);
    event FeesHarvested(address indexed token, uint256 amount);

    constructor(
        IPoolManager poolManager_,
        address gUSD_,
        IGPUPriceOracle oracle_,
        IGPUIssuance issuance_,
        address revenueLedger_,
        address initialOwner
    ) Ownable(initialOwner) {
        if (address(poolManager_) == address(0) || gUSD_ == address(0) || address(oracle_) == address(0)) {
            revert InvalidParams();
        }
        if (address(issuance_) == address(0) || revenueLedger_ == address(0)) revert InvalidParams();
        poolManager = poolManager_;
        gUSD = gUSD_;
        oracle = oracle_;
        issuance = issuance_;
        revenueLedger = revenueLedger_;
        _vault = IMarketLiquidity(issuance_.marketLiquidity());
        Hooks.Permissions memory perms = Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: true,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
        Hooks.validateHookPermissions(IHooks(address(this)), perms);
        // R8 pre-approvals: the only allowances this contract ever grants —
        // for spending absorbed gUSD in-lock (issuance base+fee, vault credit).
        IERC20(gUSD_).forceApprove(address(issuance_), type(uint256).max);
        IERC20(gUSD_).forceApprove(issuance_.marketLiquidity(), type(uint256).max);
        // EIP-170 containment: the walk machinery lives in a self-deployed
        // helper (stateless, permissionless reads only) — see PoolWalk.
        _poolWalk = new PoolWalk();
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    /// @notice Canonicality gate: only a single gUSD/GPU pool whose fee and
    ///         tickSpacing match the issuance config registers; everything
    ///         else is free to initialize but trades pure-native forever.
    function afterInitialize(address, PoolKey calldata key, uint160, int24)
        external
        override
        onlyPoolManager
        returns (bytes4)
    {
        bytes32 gpuId;
        if (Currency.unwrap(key.currency0) == gUSD) {
            gpuId = issuance.gpuIdOfToken(Currency.unwrap(key.currency1));
        } else if (Currency.unwrap(key.currency1) == gUSD) {
            gpuId = issuance.gpuIdOfToken(Currency.unwrap(key.currency0));
        } else {
            revert SingleCurrencyPoolsOnly();
        }
        if (gpuId == bytes32(0)) revert NotCanonicalPool();
        IGPUIssuance.PoolParams memory pp = issuance.poolParamsOf(gpuId);
        if (key.fee != pp.fee || key.tickSpacing != pp.tickSpacing) revert GpuMismatch();
        PoolId poolId = key.toId();
        if (poolGpuId[poolId] != bytes32(0)) revert PoolAlreadyRegistered();
        poolGpuId[poolId] = gpuId;
        emit PoolRegistered(poolId, gpuId);
        return IHooks.afterInitialize.selector;
    }

    function _ctx(PoolKey calldata key, SwapParams calldata params) internal view returns (PoolCtx memory c) {
        bytes32 gpuId = poolGpuId[key.toId()];
        if (gpuId == bytes32(0)) revert NotCanonicalPool();
        c.gpuId = gpuId;
        c.gpuToken = issuance.tokenOf(gpuId);
        c.gIsC0 = Currency.unwrap(key.currency0) == gUSD;
        c.zeroForOne = params.zeroForOne;
        c.exactIn = params.amountSpecified < 0;
        c.isBuy = params.zeroForOne == c.gIsC0;
    }

    function _paramsFor(bytes32 gpuId) internal view returns (PolParams memory p) {
        p = _polParams[gpuId];
        if (p.askBps == 0 && p.bidBps == 0) {
            p = PolParams({askBps: 50, bidBps: 50, polFeeBps: 10});
        }
    }

    /// @dev Guarded oracle read: (price, ok) — ok=false on zero price, future
    ///      timestamp, or staleness beyond maxOracleStaleness.
    function _oraclePrice(bytes32 gpuId) internal view returns (uint256 price, bool ok) {
        uint256 updatedAt;
        try oracle.getPrice(gpuId) returns (uint256 p_, uint256 u_) {
            price = p_;
            updatedAt = u_;
        } catch {
            return (0, false);
        }
        if (price == 0 || updatedAt > block.timestamp) return (0, false);
        if (block.timestamp - updatedAt > maxOracleStaleness) return (0, false);
        ok = true;
    }

    /// @notice Plan phase. Computes the native book's bounded walk to the
    ///         oracle edge; absorbs the beyond-edge input and returns it as
    ///         the specified delta (exactIn) or commits the hook's output
    ///         supply (exactOut). Stale oracle or no work to do => zero
    ///         deltas, pure-native swap. A walk cap or inventory shortfall
    ///         degrades to native-only; only a genuine no-capacity market
    ///         reverts InsufficientMarketCapacity.
    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        override
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolCtx memory ctx = _ctx(key, params);
        uint256 budget = ctx.exactIn ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        (uint256 price, bool ok) = _oraclePrice(ctx.gpuId);
        if (!ok || budget == 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }
        PolParams memory pp = _paramsFor(ctx.gpuId);
        uint256 cd = issuance.compositionDivisor();
        uint16 effAskBps = pp.askBps;
        if (polPaused) effAskBps = 0;
        uint16 issueFeeBps = issuance.feeBpsOf(ctx.gpuId);
        // POL ask is capped at the primary total (base+fee) so the backstop
        // can always close the residual at exactly the primary price (R2).
        uint256 issueAskBps = issueFeeBps;
        if (issueAskBps < effAskBps) effAskBps = uint16(issueAskBps);

        (uint160 sqrtP,, uint24 protocolFee, uint24 lpFee) = StateLibrary.getSlot0(poolManager, key.toId());
        uint24 swapFee = protocolFee == 0 ? lpFee : uint16(protocolFee).calculateSwapFee(lpFee);
        uint256 edge = uint256(_poolWalk.edgeSqrt(price, ctx.isBuy ? effAskBps : pp.bidBps, ctx.gIsC0, ctx.isBuy, cd));
        // A caller price limit tighter than the edge ends the native walk at
        // the limit; clamp so the walk mirrors Pool.swap exactly.
        uint256 limit = uint256(params.sqrtPriceLimitX96);
        if (params.sqrtPriceLimitX96 != 0) {
            edge = ctx.zeroForOne ? Math.max(edge, limit) : Math.min(edge, limit);
        }
        (uint256 w, bool hitEdge, bool capped) = _poolWalk.walk(
            poolManager,
            key.toId(),
            key.tickSpacing,
            params.zeroForOne,
            uint160(edge),
            budget,
            !ctx.exactIn,
            swapFee,
            maxWalkTicks
        );
        // No protocol work: budget exhausted mid-book (inside the spread), or
        // the walk cap hit (hard degradation — no POL fill), or the clamped
        // target is the caller's own limit.
        if (!hitEdge || capped) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }
        uint256 beyond = budget - w;
        if (beyond == 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }
        Plan memory plan = _plan(key.toId(), key.tickSpacing, ctx, pp, price, effAskBps, beyond);
        if (plan.revert_) revert InsufficientMarketCapacity();
        if (plan.deltaSpecified == 0 && plan.deltaUnspecified == 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(plan.deltaSpecified, plan.deltaUnspecified), 0);
    }

    uint256 internal constant GUSD_DUST = 5; // gUSD-wei retained by the vault
    uint256 internal constant GPU_DUST = 1; // GPU-wei absorbed by the vault

    /// @dev Stateless plan for the beyond-edge demand. R3: absorb is capped
    ///      by the PM's physical balance of the input currency (late-settling
    ///      direct swappers degrade, never revert). R10: POL notional caps.
    ///      Backstop priced with a 2-wei headroom so its total can never
    ///      exceed the absorbable budget (proven bound: total <= leftover).
    function _plan(
        PoolId poolId,
        int24 tickSpacing,
        PoolCtx memory ctx,
        PolParams memory pp,
        uint256 price,
        uint16 effAskBps,
        uint256 beyond
    ) internal view returns (Plan memory p) {
        uint256 cd = issuance.compositionDivisor();
        uint16 issueFeeBps = issuance.feeBpsOf(ctx.gpuId);
        uint256 bidDenom = price * (1e4 - uint256(pp.bidBps));
        if (ctx.isBuy) {
            uint256 pmPhysGusd = IERC20(gUSD).balanceOf(address(poolManager));
            if (ctx.exactIn) {
                uint256 gusdBudget = Math.min(beyond, pmPhysGusd);
                (
                    uint256 polGpu,
                    uint256 polSpend,
                    uint256 polFee,
                    uint256 issueGpu,
                    uint256 base,
                    uint256 fee,
                    uint256 total
                ) = _buyLadder(ctx.gpuId, pp, price, effAskBps, cd, issueFeeBps, gusdBudget, type(uint256).max);
                // Commit the FULL cap, not the ladder spend: the backstop's
                // quantity floor can leave the ladder 1-2 wei short of the
                // budget, and a realize-side absorb re-derived from the swap
                // delta (capped at pmPhys) would then exceed the frozen
                // credit by exactly that slack. The slack rides to the vault
                // as the realize tail instead (R3, commit-side).
                uint256 residual = beyond - gusdBudget;
                if (residual > GUSD_DUST) {
                    // Residual runs native past the edge — needs LPs beyond.
                    if (!_poolWalk.lpsBeyondEdge(
                            poolManager, poolId, tickSpacing, ctx.zeroForOne, price, effAskBps, ctx.gIsC0, cd
                        )) {
                        p.revert_ = true;
                        return p;
                    }
                } else {
                    gusdBudget = beyond; // dust rides to the vault tail
                }
                p.deltaSpecified = _toI128(gusdBudget);
            } else {
                uint256 demandCap = beyond; // GPU wanted beyond the edge
                // The realized take is charge + hookFee and must fit inside
                // the caller's pre-settled balance (pmPhys): budget the
                // ladder by the fee-adjusted spend cap. The ceil bound is
                // taken as-is when its own all-in take (bound + ceil fee)
                // still fits pmPhys — a router signing the quoted all-in
                // total pre-settles charge + fee exactly and must fill —
                // and gives back the reserve wei only when fee rounding
                // pushes that take past the balance (fails closed).
                uint256 spendCap = pmPhysGusd;
                if (hookFeeBps > 0) {
                    uint256 ceilCap = Math.mulDiv(pmPhysGusd, 1e4, 1e4 + uint256(hookFeeBps), Math.Rounding.Ceil);
                    uint256 ceilFee = Math.mulDiv(ceilCap, uint256(hookFeeBps), 1e4, Math.Rounding.Ceil);
                    spendCap = ceilCap + ceilFee <= pmPhysGusd ? ceilCap : (ceilCap > 0 ? ceilCap - 1 : 0);
                }
                (
                    uint256 polGpu,
                    uint256 polSpend,
                    uint256 polFee,
                    uint256 issueGpu,
                    uint256 base,
                    uint256 fee,
                    uint256 total
                ) = _buyLadder(ctx.gpuId, pp, price, effAskBps, cd, issueFeeBps, spendCap, demandCap);
                uint256 covered = polGpu + issueGpu;
                uint256 residual = beyond - covered;
                if (residual > GPU_DUST) {
                    if (!_poolWalk.lpsBeyondEdge(
                            poolManager, poolId, tickSpacing, ctx.zeroForOne, price, effAskBps, ctx.gIsC0, cd
                        )) {
                        p.revert_ = true;
                        return p;
                    }
                }
                p.deltaSpecified = _toI128Neg(covered);
                p.deltaUnspecified = _toI128(polSpend + total);
            }
        } else {
            // Sells: input GPU, output gUSD. POL bid is the only protocol
            // source — no synthetic redemption, ever.
            uint256 pmPhysGpu = IERC20(ctx.gpuToken).balanceOf(address(poolManager));
            uint256 bidInv = _vault.bidInventoryGusd(ctx.gpuId);
            uint256 capLeft = _polCapLeft();
            // capLeft == 0 means POL disabled for this swap (caps kill, not lift).
            uint256 capGpu = capLeft == 0 ? 0 : Math.mulDiv(capLeft, 1e20, bidDenom);
            if (ctx.exactIn) {
                uint256 expressible = bidDenom > 0 ? Math.mulDiv(bidInv, 1e20, bidDenom) : 0;
                uint256 polGpu = Math.min(Math.min(beyond, expressible), Math.min(capGpu, pmPhysGpu));
                uint256 gross = Math.mulDiv(polGpu, bidDenom, 1e20);
                uint256 polFee = Math.mulDiv(gross, pp.polFeeBps, 1e4, Math.Rounding.Ceil);
                uint256 absorb = polGpu;
                uint256 residual = beyond - polGpu;
                if (residual > GPU_DUST) {
                    if (!_poolWalk.lpsBeyondEdge(
                            poolManager, poolId, tickSpacing, ctx.zeroForOne, price, pp.bidBps, ctx.gIsC0, cd
                        )) {
                        p.revert_ = true;
                        return p;
                    }
                }
                if (residual <= GPU_DUST) absorb = beyond; // vault absorbs the dust GPU
                p.deltaSpecified = _toI128(absorb);
            } else {
                // Sell exactOut gUSD. C-primary: the hook commits the walk
                // shortfall unperturbed and the seller bears both fees through
                // the absorb price (gross = supply + fees, priced at bid).
                // Committing the shortfall directly keeps the native leg on
                // exactly its simulated walk, so the realize recovers the
                // commit from the swap delta with no fee algebra to invert —
                // the old net-minus-hookFee commit made a realize-side
                // re-derivation re-charge the fee and left the hook exactly
                // -hookFee in debt at unlock (CurrencyNotSettled).
                uint256 supply = beyond;
                // gross(supply) must fit the vault float, the R10 notional
                // cap (capLeft == 0 kills POL), and the PM's physical GPU (R3).
                uint256 budget = bidInv;
                if (capLeft < budget) budget = capLeft;
                uint256 grossMax = Math.mulDiv(pmPhysGpu, bidDenom, 1e20);
                if (grossMax < budget) budget = grossMax;
                if (supply > 0) {
                    uint256 supplyCap = _supplyForGrossBudget(budget, pp.polFeeBps, hookFeeBps);
                    if (supply > supplyCap) supply = supplyCap;
                }
                uint256 polFee = Math.mulDiv(supply, pp.polFeeBps, 1e4, Math.Rounding.Ceil);
                uint256 hookFee = Math.mulDiv(supply, hookFeeBps, 1e4, Math.Rounding.Ceil);
                uint256 gross = supply + polFee + hookFee;
                uint256 gpuAbs = bidDenom > 0 ? Math.mulDiv(gross, 1e20, bidDenom, Math.Rounding.Ceil) : 0;
                uint256 residual = beyond - supply;
                if (residual > GUSD_DUST) {
                    if (!_poolWalk.lpsBeyondEdge(
                            poolManager, poolId, tickSpacing, ctx.zeroForOne, price, pp.bidBps, ctx.gIsC0, cd
                        )) {
                        p.revert_ = true;
                        return p;
                    }
                }
                p.deltaSpecified = _toI128Neg(supply);
                p.deltaUnspecified = _toI128(gpuAbs);
            }
        }
    }

    /// @dev Largest supply whose gross draw `supply + polFee + hookFee` stays
    ///      within `budget` (vault float / R10 cap / PM-priced GPU). The
    ///      initial estimate overshoots by at most the two ceil-rounding wei;
    ///      fees are non-decreasing in the supply, so one exact shrink step
    ///      always lands inside — bounded loop, pure arithmetic.
    function _supplyForGrossBudget(uint256 budget, uint16 polFeeBps, uint16 hookFeeBps)
        internal
        pure
        returns (uint256 supply)
    {
        if (budget == 0) return 0;
        uint256 spread = uint256(polFeeBps) + uint256(hookFeeBps);
        supply = Math.mulDiv(budget, 1e4, 1e4 + spread); // floor
        for (uint256 i; i < 4; ++i) {
            uint256 gross = supply + Math.mulDiv(supply, polFeeBps, 1e4, Math.Rounding.Ceil)
                + Math.mulDiv(supply, hookFeeBps, 1e4, Math.Rounding.Ceil);
            if (gross <= budget) break;
            uint256 over = gross - budget;
            supply = over >= supply ? 0 : supply - over;
        }
    }

    /// @dev The buy ladder for a gUSD budget: POL ask inventory first, then
    ///      the issuance backstop priced at the primary total with a 2-wei
    ///      headroom (proven bound: base + fee <= leftover). Returns the POL
    ///      fill (polGpu @ polSpend, polFee off the top) and the backstop
    ///      fill (issueGpu for base + fee). demandCap bounds the GPU demand
    ///      (exactOut shapes); type(uint256).max for exactIn.
    function _buyLadder(
        bytes32 gpuId,
        PolParams memory pp,
        uint256 price,
        uint16 effAskBps,
        uint256 cd,
        uint16 issueFeeBps,
        uint256 gusdBudget,
        uint256 demandCap
    )
        internal
        view
        returns (
            uint256 polGpu,
            uint256 polSpend,
            uint256 polFee,
            uint256 issueGpu,
            uint256 base,
            uint256 fee,
            uint256 total
        )
    {
        if (gusdBudget == 0) return (0, 0, 0, 0, 0, 0, 0);
        uint256 denomAsk = price * (1e4 + uint256(effAskBps));
        uint256 askInv = _vault.askInventoryGpu(gpuId);
        uint256 capLeft = _polCapLeft();
        uint256 capGpu = capLeft == 0 ? 0 : Math.mulDiv(capLeft, 1e20, denomAsk);
        uint256 affordable = Math.mulDiv(gusdBudget, 1e20, denomAsk);
        polGpu = Math.min(Math.min(affordable, askInv), Math.min(capGpu, demandCap));
        polSpend = Math.mulDiv(polGpu, denomAsk, 1e20, Math.Rounding.Ceil);
        polFee = Math.mulDiv(polSpend, pp.polFeeBps, 1e4, Math.Rounding.Ceil);
        uint256 leftover = gusdBudget - polSpend;
        uint256 issueHeadroom = leftover >= 2 ? leftover - 2 : 0;
        uint256 issueBudget = Math.mulDiv(issueHeadroom, cd * 1e4, price * (1e4 + uint256(issueFeeBps)));
        uint256 want = demandCap - polGpu;
        // Demand-first: the conservative issueBudget under-approximates what
        // the leftover affords (division flooring plus the 2-wei reserve),
        // which on a dry book strands a phantom residual that reverts an
        // affordable swap. Quote the exact residual demand and fill it when
        // the total fits the leftover — the quote is exact, so the reserve
        // is surplus there and the realize ledger still closes (the commit
        // is delta-derived, never re-planned). Fall back to the conservative
        // budget when the exact total does not fit or the quote degrades.
        bool filled = false;
        if (want != 0) {
            try issuance.quoteIssueCredited(gpuId, want) returns (uint256 b, uint256 f, uint256 t) {
                if (t <= leftover) {
                    issueGpu = want;
                    base = b;
                    fee = f;
                    total = t;
                    filled = true;
                }
            } catch {
                base = 0;
                fee = 0;
                total = 0;
            }
        }
        if (!filled) {
            issueGpu = Math.min(want, issueBudget);
            if (issueGpu > 0) {
                try issuance.quoteIssueCredited(gpuId, issueGpu) returns (uint256 b, uint256 f, uint256 t) {
                    base = b;
                    fee = f;
                    total = t;
                } catch {
                    base = 0;
                    fee = 0;
                    total = 0;
                    issueGpu = 0;
                }
            }
        }
    }

    /// @dev Remaining POL capacity: min(per-swap cap, per-block remaining).
    ///      0 disables POL for the swap (caps kill, never lift).
    function _polCapLeft() internal view returns (uint256 c) {
        c = maxPolNotionalGusd;
        uint256 perBlock = perBlockPolCapGusd;
        if (perBlock != 0) {
            uint256 used = _polVolumeByBlock[block.number];
            c = Math.min(c, perBlock > used ? perBlock - used : 0);
        }
    }

    function _toI128(uint256 v) internal pure returns (int128) {
        if (v > uint256(uint128(type(int128).max))) revert DeltaTooLarge();
        return int128(int256(v));
    }

    function _toI128Neg(uint256 v) internal pure returns (int128) {
        return -_toI128(v);
    }

    /// @notice Realize phase. Recovers the hook's absorb/supply from the
    ///         native swapDelta (the pre-hookDelta native result), re-derives
    ///         every spend from a fresh guarded oracle read, settles both
    ///         legs to ledger zero, and emits HookSwap + one GpuFill per
    ///         fill source. Stateless: safe under repeated swaps per lock.
    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta swapDelta,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, int128) {
        PoolCtx memory ctx = _ctx(key, params);
        (uint256 price, bool ok) = _oraclePrice(ctx.gpuId);
        if (!ok) return (IHooks.afterSwap.selector, 0);

        // Specified currency: input for exactIn, output for exactOut.
        bool specIsC0 = ctx.exactIn == ctx.zeroForOne;
        int256 nativeSpec = int256(specIsC0 ? swapDelta.amount0() : swapDelta.amount1());

        int128 delta = 0;
        if (ctx.exactIn) {
            // Absorb recovered: what the caller paid beyond the native leg.
            uint256 absorb = uint256(-params.amountSpecified) - uint256(-nativeSpec);
            // R3 (realize side): a native leg that runs past the edge and
            // dries up (late-settling caller, thin book beyond) re-derives a
            // larger absorb from the swap delta than the plan committed.
            // Re-apply the plan's physical-balance cap so the take below can
            // never exceed what the PM holds — degrade, never revert.
            if (absorb > 0) {
                uint256 pmPhys = ctx.isBuy
                    ? IERC20(gUSD).balanceOf(address(poolManager))
                    : IERC20(ctx.gpuToken).balanceOf(address(poolManager));
                if (absorb > pmPhys) absorb = pmPhys;
            }
            if (absorb == 0) return (IHooks.afterSwap.selector, 0);
            delta = ctx.isBuy
                ? _settleBuyIn(sender, key, ctx, absorb, price)
                : _settleSellIn(sender, key, ctx, absorb, price);
        } else {
            // Supply recovered: what the hook owes beyond the native output.
            uint256 supplied = uint256(params.amountSpecified) - uint256(nativeSpec);
            if (supplied == 0) return (IHooks.afterSwap.selector, 0);
            delta = ctx.isBuy
                ? _settleBuyOut(sender, key, ctx, supplied, price)
                : _settleSellOut(sender, key, ctx, supplied, price);
        }
        return (IHooks.afterSwap.selector, delta);
    }

    /// @dev Buy, exactIn gUSD: absorb gUSD taken from the PM (pre-settled
    ///      caller input; R3-capped at plan), spent on the POL ladder +
    ///      backstop, GPU delivered to the PM. Tail beyond the recomputed
    ///      ladder rides to the vault (bounded rounding remainder). The hook
    ///      fee is taken IN KIND — gpuFee GPU off the delivered fills,
    ///      routed to the revenue ledger — because the specified delta is
    ///      frozen at beforeSwap and only the output leg is adjustable in
    ///      afterSwap.
    function _settleBuyIn(address sender, PoolKey calldata key, PoolCtx memory ctx, uint256 absorb, uint256 price)
        internal
        returns (int128)
    {
        PolParams memory pp = _paramsFor(ctx.gpuId);
        uint256 cd = issuance.compositionDivisor();
        uint16 issueFeeBps = issuance.feeBpsOf(ctx.gpuId);
        (uint256 polGpu, uint256 polSpend, uint256 polFee, uint256 issueGpu, uint256 base, uint256 fee, uint256 total) =
            _buyLadder(ctx.gpuId, pp, price, _effAskBps(pp, ctx.gpuId), cd, issueFeeBps, absorb, type(uint256).max);
        poolManager.take(Currency.wrap(gUSD), address(this), absorb);
        Currency gpuCur = ctx.gIsC0 ? key.currency1 : key.currency0;
        if (polGpu > 0) {
            poolManager.sync(gpuCur);
            _vault.pullGpuToManager(ctx.gpuId, polGpu);
            poolManager.settle();
        }
        if (issueGpu > 0) {
            issuance.issueCredited(ctx.gpuId, issueGpu, address(this), absorb - polSpend);
            poolManager.sync(gpuCur);
            IERC20(ctx.gpuToken).safeTransfer(address(poolManager), issueGpu);
            poolManager.settle();
        }
        uint256 grossGpu = polGpu + issueGpu;
        uint256 gpuFee = Math.mulDiv(grossGpu, hookFeeBps, 1e4, Math.Rounding.Ceil);
        if (gpuFee > 0) poolManager.take(gpuCur, revenueLedger, gpuFee);
        uint256 tail = absorb - (polSpend + total);
        if (polFee > 0) IERC20(gUSD).safeTransfer(revenueLedger, polFee);
        if (polSpend > polFee) _vault.creditBidFromTrade(ctx.gpuId, polSpend - polFee + tail);
        else if (tail > 0) _vault.creditBidFromTrade(ctx.gpuId, tail);
        _bookPol(polSpend, polFee);
        if (polGpu > 0) emit GpuFill(key.toId(), ctx.gpuId, sender, true, polGpu, polSpend, polFee, 0);
        if (issueGpu > 0) emit GpuFill(key.toId(), ctx.gpuId, sender, true, issueGpu, base + fee, fee, 1);
        _emitHookSwap(key.toId(), sender, ctx.gIsC0, _toI128Neg(absorb), _toI128(grossGpu - gpuFee));
        return -_toI128(grossGpu - gpuFee);
    }

    /// @dev Sell, exactIn GPU: absorbed GPU taken straight to the vault (the
    ///      only source of permanent POL GPU), seller funded from bid
    ///      inventory at the bid edge, net of POL fee and hook fee.
    function _settleSellIn(address sender, PoolKey calldata key, PoolCtx memory ctx, uint256 absorb, uint256 price)
        internal
        returns (int128)
    {
        PolParams memory pp = _paramsFor(ctx.gpuId);
        uint256 bidDenom = price * (1e4 - uint256(pp.bidBps));
        uint256 bidInv = _vault.bidInventoryGusd(ctx.gpuId);
        uint256 capLeft = _polCapLeft();
        uint256 capGpu = capLeft == 0 ? 0 : Math.mulDiv(capLeft, 1e20, bidDenom);
        uint256 polGpu = Math.min(Math.min(absorb, Math.mulDiv(bidInv, 1e20, bidDenom)), capGpu);
        uint256 gross = Math.mulDiv(polGpu, bidDenom, 1e20);
        uint256 polFee = Math.mulDiv(gross, pp.polFeeBps, 1e4, Math.Rounding.Ceil);
        uint256 net = gross - polFee;
        uint256 hookFee = Math.mulDiv(net, hookFeeBps, 1e4, Math.Rounding.Ceil);
        poolManager.take(Currency.wrap(ctx.gpuToken), address(_vault), absorb);
        _vault.noteGpu(ctx.gpuId, absorb);
        Currency gusdCur = Currency.wrap(gUSD);
        if (gross > 0) {
            poolManager.sync(gusdCur);
            _vault.pullGusdToManager(ctx.gpuId, gross);
            poolManager.settle();
        }
        if (polFee + hookFee > 0) poolManager.take(gusdCur, revenueLedger, polFee + hookFee);
        totalHookFeesGusd += hookFee;
        _bookPol(gross, polFee);
        if (polGpu > 0) emit GpuFill(key.toId(), ctx.gpuId, sender, false, polGpu, gross, polFee, 0);
        _emitHookSwap(key.toId(), sender, ctx.gIsC0, _toI128(net - hookFee), _toI128Neg(absorb));
        return -_toI128(net - hookFee);
    }

    /// @dev Buy, exactOut GPU: the hook supplies the beyond-edge GPU (POL +
    ///      backstop), collects the ask-priced charge. The charge is taken
    ///      FIRST (physical funding for the backstop transferFrom), then GPU
    ///      is delivered. Deterministic recompute == plan, so the committed
    ///      beforeSwap charge is exact; divergence reverts via unlock.
    function _settleBuyOut(address sender, PoolKey calldata key, PoolCtx memory ctx, uint256 supplied, uint256 price)
        internal
        returns (int128)
    {
        PolParams memory pp = _paramsFor(ctx.gpuId);
        uint16 effAskBps = _effAskBps(pp, ctx.gpuId);
        uint256 denomAsk = price * (1e4 + uint256(effAskBps));
        uint256 capLeft = _polCapLeft();
        uint256 capGpu = capLeft == 0 ? 0 : Math.mulDiv(capLeft, 1e20, denomAsk);
        uint256 polGpu = Math.min(Math.min(supplied, _vault.askInventoryGpu(ctx.gpuId)), capGpu);
        uint256 polSpend = Math.mulDiv(polGpu, denomAsk, 1e20, Math.Rounding.Ceil);
        uint256 polFee = Math.mulDiv(polSpend, pp.polFeeBps, 1e4, Math.Rounding.Ceil);
        uint256 issueGpu = supplied - polGpu;
        uint256 base;
        uint256 fee;
        uint256 charge = polSpend;
        if (issueGpu > 0) {
            (uint256 b, uint256 f, uint256 t) = issuance.quoteIssueCredited(ctx.gpuId, issueGpu);
            base = b;
            fee = f;
            charge = polSpend + t;
        }
        uint256 hookFee = Math.mulDiv(charge, hookFeeBps, 1e4, Math.Rounding.Ceil);
        poolManager.take(Currency.wrap(gUSD), address(this), charge + hookFee);
        Currency gpuCur = ctx.gIsC0 ? key.currency1 : key.currency0;
        if (polGpu > 0) {
            poolManager.sync(gpuCur);
            _vault.pullGpuToManager(ctx.gpuId, polGpu);
            poolManager.settle();
        }
        if (issueGpu > 0) {
            issuance.issueCredited(ctx.gpuId, issueGpu, address(this), charge - polSpend);
            poolManager.sync(gpuCur);
            IERC20(ctx.gpuToken).safeTransfer(address(poolManager), issueGpu);
            poolManager.settle();
        }
        if (polFee > 0) IERC20(gUSD).safeTransfer(revenueLedger, polFee);
        if (hookFee > 0) IERC20(gUSD).safeTransfer(revenueLedger, hookFee);
        totalHookFeesGusd += hookFee;
        if (polSpend > polFee) _vault.creditBidFromTrade(ctx.gpuId, polSpend - polFee);
        _bookPol(polSpend, polFee);
        if (polGpu > 0) emit GpuFill(key.toId(), ctx.gpuId, sender, true, polGpu, polSpend, polFee, 0);
        if (issueGpu > 0) emit GpuFill(key.toId(), ctx.gpuId, sender, true, issueGpu, base + fee, fee, 1);
        _emitHookSwap(key.toId(), sender, ctx.gIsC0, _toI128Neg(charge + hookFee), _toI128(supplied));
        // The unspecified leg is the gUSD input for buys: the fee rides on
        // top of the beforeSwap charge, so afterSwap must ADD it to the
        // hook's ledger (the take debits charge + hookFee).
        return _toI128(hookFee);
    }

    /// @dev Sell, exactOut gUSD: the vault funds the caller's committed
    ///      supply C at gross = C + polFee + hookFee (seller bears both fees
    ///      through the absorb price), and the hook absorbs the priced GPU to
    ///      the vault. The recovered supply matches the commit by
    ///      construction — the native leg ran exactly its simulated walk —
    ///      and a dry native leg recovers MORE, so the hook's own frozen
    ///      ledger debt is the commit of record: the cap below keeps every
    ///      settle/take inside the beforeSwap credit and the ledger closes
    ///      at zero unconditionally.
    function _settleSellOut(address sender, PoolKey calldata key, PoolCtx memory ctx, uint256 supplied, uint256 price)
        internal
        returns (int128)
    {
        PolParams memory pp = _paramsFor(ctx.gpuId);
        uint256 bidDenom = price * (1e4 - uint256(pp.bidBps));
        Currency gusdCur = Currency.wrap(gUSD);
        uint256 supply = supplied;
        int256 committed = TransientStateLibrary.currencyDelta(poolManager, address(this), gusdCur);
        if (committed < 0 && supply > uint256(-committed)) supply = uint256(-committed);
        uint256 polFee = Math.mulDiv(supply, pp.polFeeBps, 1e4, Math.Rounding.Ceil);
        uint256 hookFee = Math.mulDiv(supply, hookFeeBps, 1e4, Math.Rounding.Ceil);
        uint256 gross = supply + polFee + hookFee;
        uint256 gpuAbs = bidDenom > 0 ? Math.mulDiv(gross, 1e20, bidDenom, Math.Rounding.Ceil) : 0;
        if (gross > 0) {
            poolManager.sync(gusdCur);
            _vault.pullGusdToManager(ctx.gpuId, gross);
            poolManager.settle();
        }
        if (polFee + hookFee > 0) poolManager.take(gusdCur, revenueLedger, polFee + hookFee);
        totalHookFeesGusd += hookFee;
        if (gpuAbs > 0) {
            poolManager.take(Currency.wrap(ctx.gpuToken), address(_vault), gpuAbs);
            _vault.noteGpu(ctx.gpuId, gpuAbs);
        }
        _bookPol(gross, polFee);
        if (gpuAbs > 0) emit GpuFill(key.toId(), ctx.gpuId, sender, false, gpuAbs, gross, polFee, 0);
        _emitHookSwap(key.toId(), sender, ctx.gIsC0, _toI128(supply), _toI128Neg(gpuAbs));
        return 0;
    }

    /// @dev POL ask capped at the primary ask so the backstop can always
    ///      close the residual at exactly the primary total (R2).
    function _effAskBps(PolParams memory pp, bytes32 gpuId) internal view returns (uint16 effAskBps) {
        effAskBps = polPaused ? 0 : pp.askBps;
        uint16 issueFeeBps = issuance.feeBpsOf(gpuId);
        if (issueFeeBps < effAskBps) effAskBps = issueFeeBps;
    }

    function _bookPol(uint256 notional, uint256 fee) internal {
        _polVolumeByBlock[block.number] += notional;
        totalPolNotionalGusd += notional;
        totalPolFeesGusd += fee;
    }

    /// @dev URC-2 HookSwap in swapper-view signed deltas (positive = the
    ///      swapper received from hook fills). `sender` is the PoolManager —
    ///      the true swapper is not identifiable in-lock; indexers join
    ///      GpuFill to the core Swap event on txHash.
    function _emitHookSwap(PoolId poolId, address sender, bool gIsC0, int128 gusdView, int128 gpuView) internal {
        (,, uint24 protocolFee, uint24 lpFee) = StateLibrary.getSlot0(poolManager, poolId);
        uint24 swapFee = protocolFee == 0 ? lpFee : uint16(protocolFee).calculateSwapFee(lpFee);
        if (gIsC0) emit HookSwap(poolId, sender, gusdView, gpuView, swapFee);
        else emit HookSwap(poolId, sender, gpuView, gusdView, swapFee);
    }

    // ------------------------------------------------------------- lens --

    /// @notice URC-3: orientation-mapped vault inventories.
    function getReserves(PoolKey calldata key) external view returns (uint256 amount0, uint256 amount1) {
        bytes32 gpuId = poolGpuId[key.toId()];
        if (gpuId == bytes32(0)) revert NotCanonicalPool();
        uint256 gpuInv = _vault.askInventoryGpu(gpuId);
        uint256 gusdInv = _vault.bidInventoryGusd(gpuId);
        (amount0, amount1) = Currency.unwrap(key.currency0) == gUSD ? (gusdInv, gpuInv) : (gpuInv, gusdInv);
    }

    /// @notice URC-3: the hook's sellable/buyable depth — same as reserves.
    function getEffectiveLiquidity(PoolKey calldata key) external view returns (uint256 amount0, uint256 amount1) {
        return this.getReserves(key);
    }

    /// @notice URC-3.
    function hook() external view returns (address) {
        return address(this);
    }

    function supportsInterface(bytes4 interfaceId) external view returns (bool) {
        return interfaceId == type(IHookStats).interfaceId || interfaceId == type(IHooks).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }

    /// @notice Merged-book state for a GPU: POL params, live flag (fresh
    ///         oracle, not paused, some capacity), and edge prices in the
    ///         oracle's 4-decimal convention.
    function polState(bytes32 gpuId)
        external
        view
        returns (uint16 askBps, uint16 bidBps, uint16 polFeeBps, bool live, uint256 askPrice, uint256 bidPrice)
    {
        PolParams memory pp = _paramsFor(gpuId);
        (uint256 price, bool ok) = _oraclePrice(gpuId);
        askBps = pp.askBps;
        bidBps = pp.bidBps;
        polFeeBps = pp.polFeeBps;
        live = ok && !polPaused;
        if (ok) {
            // Quote doctrine: mirror _effAskBps (pause + R2 issuance cap) so
            // the view's ask edge is the edge execution actually walks to.
            uint16 effAskBps = polPaused ? 0 : pp.askBps;
            uint16 issueFeeBps = issuance.feeBpsOf(gpuId);
            if (issueFeeBps < effAskBps) effAskBps = issueFeeBps;
            (askPrice, bidPrice) =
            (Math.mulDiv(price, 1e4 + uint256(effAskBps), 1e4), Math.mulDiv(price, 1e4 - uint256(pp.bidBps), 1e4));
        }
    }

    // ------------------------------------------------------------- admin --

    function setPolParams(bytes32 gpuId, uint16 askBps, uint16 bidBps, uint16 polFeeBps) external onlyOwner {
        if (askBps > MAX_SPREAD_BPS || bidBps > MAX_SPREAD_BPS || polFeeBps > MAX_SPREAD_BPS) revert FeeTooLarge();
        // R2 solvency: the vault must net a non-negative share of the ask.
        if (polFeeBps > askBps) revert FeeTooLarge();
        _polParams[gpuId] = PolParams({askBps: askBps, bidBps: bidBps, polFeeBps: polFeeBps});
        emit PolParamsSet(gpuId, askBps, bidBps, polFeeBps);
    }

    function setPolPaused(bool paused) external onlyOwner {
        polPaused = paused;
        emit PolPausedSet(paused);
    }

    function setMaxOracleStaleness(uint256 seconds_) external onlyOwner {
        maxOracleStaleness = seconds_;
        emit MaxOracleStalenessSet(seconds_);
    }

    function setMaxWalkTicks(uint256 v) external onlyOwner {
        if (v == 0) revert InvalidParams();
        maxWalkTicks = v;
        emit MaxWalkTicksSet(v);
    }

    function setPolCaps(uint256 maxPolNotionalGusd_, uint256 perBlockPolCapGusd_) external onlyOwner {
        maxPolNotionalGusd = maxPolNotionalGusd_;
        perBlockPolCapGusd = perBlockPolCapGusd_;
        emit PolCapsSet(maxPolNotionalGusd_, perBlockPolCapGusd_);
    }

    function setHookFeeBps(uint16 feeBps) external onlyOwner {
        if (feeBps > MAX_HOOK_FEE_BPS) revert FeeTooLarge();
        emit HookFeeBpsSet(hookFeeBps, feeBps);
        hookFeeBps = feeBps;
    }

    // ------------------------------------------------- non-canonical stubs --

    function beforeInitialize(address, PoolKey calldata, uint160) external pure override returns (bytes4) {
        revert NotCanonicalPool();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert NotCanonicalPool();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert NotCanonicalPool();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert NotCanonicalPool();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert NotCanonicalPool();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert NotCanonicalPool();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert NotCanonicalPool();
    }
}
