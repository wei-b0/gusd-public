// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SafeCallback} from "@uniswap/v4-periphery/base/SafeCallback.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/libraries/LiquidityAmounts.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {GUSD} from "./GUSD.sol";
import {IGPUIssuance} from "./interfaces/IGPUIssuance.sol";
import {IMarketLiquidity} from "./interfaces/IMarketLiquidity.sol";
import {GPUHook} from "./hooks/GPUHook.sol";
import {GpuPoolKey} from "./libraries/GpuPoolKey.sol";

/// @title GPUMarketLiquidity — protocol-owned liquidity capitalized by primary demand.
/// @notice Every primary GPU buy sends its gUSD principal here instead of a
///         passive reserve. The principal accumulates as `pendingPrincipal`
///         and is placed — permissionlessly — as single-sided bid bands
///         around the canonical pool's oracle-anchored reference price, so
///         primary demand deepens the market it created instead of leaving
///         the quote side of the market. GPU received from sellers (band
///         conversions) or LP fee accrual cycles back as ask-side liquidity.
///         There is no withdrawal path: principal can only become in-position
///         gUSD, converted GPU, or pool swaps to traders; LP fees are the only
///         revenue path. POL never mints GPU.
/// @dev    Placement geometry (h = gUSD-wei per GPU-wei; the pool tick is
///         monotonic in the pool's currency1-per-currency0 price):
///         - issuance ask at h_ask = h_oracle x (1 + feeBps) -> tick tAsk.
///         - gUSD = currency0 (tick falls as h rises):
///           bid band [tAsk + spread, tAsk + spread + width] — gUSD-only while
///           the pool tick sits below it; ask band [tAsk - width, tAsk] —
///           GPU-only while the pool tick sits at or above it.
///         - gUSD = currency1 (tick rises as h rises): mirrored — bid band
///           [tAsk - spread - width, tAsk - spread], ask band [tAsk, tAsk + width].
///         A band whose range is entirely on the far side of the pool tick
///         holds exactly one currency, so bids require zero GPU and asks
///         require zero gUSD: no 50/50 pairing, no subsidy. When the pool
///         sits inside a band the placement clamps to just beyond the current
///         tick; when the pool is priced past the whole band the placement is
///         deferred (principal stays pending / GPU stays staged) until
///         arbitrage converges the pool — bids are never placed above the
///         market and asks never below it. Bands merge on identical ranges
///         (salt 0) and ladder when the reference has moved; `recenter`
///         removes stale bands and re-prices the same real inventory around
///         the current reference (removal is not a swap — nobody transacts at
///         the stale prices). Solvency: liquidity is floored from the
///         available amount and the manager's rounded-up delta can never
///         exceed it. `referenceSqrtPriceX96` is staleness-guarded: nothing
///         is ever placed at a stale anchor.
contract GPUMarketLiquidity is SafeCallback, Ownable2Step, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeERC20 for IERC20;

    /// @notice A single-sided liquidity band the POL maintains in the
    ///         canonical pool. `liquidity` is the placement-time v4 position
    ///         size; `gusdPlaced`/`gpuPlaced` record the principal-derived
    ///         gUSD and inventory-derived GPU converted into the range.
    struct Band {
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 gusdPlaced;
        uint256 gpuPlaced;
    }

    /// @notice A fully-resolved placement: aligned single-sided range, floored
    ///         liquidity, and the exact rounded-up principal the manager will
    ///         debit (`required` <= available by construction).
    struct Placement {
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 required;
    }

    /// @notice Oracle-anchored target zones in pool-tick space, clamped to the
    ///         representable tick range.
    struct Zones {
        int24 bidLo;
        int24 bidHi;
        int24 askLo;
        int24 askHi;
    }

    /// @notice Recenter payload passed through the unlock.
    struct RecenterPlan {
        bytes32 gpuId;
        int24[] lows;
        int24[] highs;
        uint256 count;
        int24 bidLo;
        int24 bidHi;
        bool placeBid;
        int24 askLo;
        int24 askHi;
        bool placeAsk;
        bool gIsC0;
    }

    // poolManager immutable is inherited from SafeCallback/ImmutableState
    GUSD public immutable gUSD;
    address public immutable revenueLedger;

    // one-shot refs (set by the owner after the dependent contracts exist;
    // breaks the POL <-> issuance construction cycle). `hook` may be
    // address(0) in minimal rigs — placement ops revert RefsIncomplete.
    address public issuance;
    address public hook;

    uint8 private constant ACTION_DEPLOY = 0; // pending gUSD -> bid band
    uint8 private constant ACTION_PLACE_ASK = 1; // inventory GPU -> ask band
    uint8 private constant ACTION_RECENTER = 2; // remove stale bands, redeploy
    uint8 private constant ACTION_COLLECT = 3; // poke bands, sweep fees

    mapping(bytes32 => Band[]) internal _bands;
    /// @notice gUSD principal awaiting placement (plus recovered-but-unplaceable gUSD).
    mapping(bytes32 => uint256) public pendingPrincipal;
    /// @notice Cumulative principal received from primary issuance. An
    ///         accounting statistic, NOT a claim on present assets: principal
    ///         converts to GPU through legitimate market trades.
    mapping(bytes32 => uint256) public principalContributed;
    /// @notice Cumulative principal across all GPUs.
    uint256 public totalPrincipalContributed;
    /// @notice Placement dust: gUSD too small to place at the target band,
    ///         carried into the next deployment.
    mapping(bytes32 => uint256) internal _residual;
    /// @notice GPU awaiting ask-side placement: band conversions recovered by
    ///         recenter, unplaceable asks, and GPU-denominated LP fees.
    mapping(bytes32 => uint256) public gpuInventory;
    /// @notice gUSD LP fees swept from the pool, awaiting `collect()`.
    mapping(bytes32 => uint256) public feesPendingGusd;

    error RefsNotSet();
    error RefsAlreadySet();
    error RefsIncomplete();
    error NotIssuance();
    error ZeroAmount();
    error UnknownGpuId();
    error BandRangeInvalid();
    error BandIndexOutOfRange();
    error NothingToRecenter();
    error UnexpectedDelta();
    error OraclePriceRange();

    event RefsSet(address indexed issuance, address indexed hook);
    event PrincipalPending(bytes32 indexed gpuId, uint256 amount);
    event BandPlaced(
        bytes32 indexed gpuId,
        PoolId indexed poolId,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 gusdPlaced,
        uint256 gpuPlaced,
        bool bidSide
    );
    event BandRemoved(
        bytes32 indexed gpuId, PoolId indexed poolId, int24 tickLower, int24 tickUpper, uint256 recoveredGusd, uint256 recoveredGpu
    );
    event Recentred(bytes32 indexed gpuId, uint256 bandsRemoved, uint256 gusdRecovered, uint256 gpuRecovered);
    event FeesCollected(bytes32 indexed gpuId, uint256 gusdToLedger, uint256 gpuToInventory);

    constructor(IPoolManager poolManager_, GUSD gUSD_, address revenueLedger_, address initialOwner)
        SafeCallback(poolManager_)
        Ownable(initialOwner)
    {
        gUSD = gUSD_;
        revenueLedger = revenueLedger_;
        // The manager pulls gUSD only via POL-initiated settle(); the GPU
        // token is NEVER approved — takes push GPU out, and GPU settles from
        // the POL's own balance.
        IERC20(address(gUSD_)).forceApprove(address(poolManager_), type(uint256).max);
    }

    // ----------------------------------------------------------------- refs

    function setRefs(address issuance_, address hook_) external onlyOwner {
        if (issuance != address(0)) revert RefsAlreadySet();
        if (issuance_ == address(0)) revert RefsNotSet();
        issuance = issuance_;
        hook = hook_;
        emit RefsSet(issuance_, hook_);
    }

    // ------------------------------------------------------------ issuance

    /// @notice Accounting entry for primary-buy principal (see
    ///         IMarketLiquidity). Called by GPUIssuance after the principal
    ///         has been transferred. Accounting only — cannot fail on v4
    ///         state, so a v4 problem can never take down primary issuance.
    /// @dev The interface is intentionally narrow (see IMarketLiquidity);
    ///      this contract implements it without inheriting it so the POL
    ///      surface stays explicit.
    function notePrincipal(bytes32 gpuId, uint256 amount) external nonReentrant {
        if (msg.sender != issuance) revert NotIssuance();
        if (amount == 0) revert ZeroAmount();
        pendingPrincipal[gpuId] += amount;
        principalContributed[gpuId] += amount;
        totalPrincipalContributed += amount;
        emit PrincipalPending(gpuId, amount);
    }

    // ------------------------------------------------------- liquidity ops

    /// @notice Places all pending principal for `gpuId` as a bid band.
    ///         Permissionless. No-ops (returns false) when the canonical pool
    ///         does not exist yet, the reference is unplaceable right now, or
    ///         the amount is too small — the principal stays pending and the
    ///         next attempt retries.
    /// @return placed true when a band was placed (or merged).
    function deployPending(bytes32 gpuId) external nonReentrant returns (bool placed) {
        if (issuance == address(0) || hook == address(0)) revert RefsIncomplete();
        uint256 available = pendingPrincipal[gpuId] + _residual[gpuId];
        if (available == 0) return false;
        PoolKey memory key = _poolKey(gpuId);
        if (GPUHook(hook).poolGpuId(key.toId()) == bytes32(0)) return false; // pre-pool issuance
        (, int24 tick,,) = IPoolManager(poolManager).getSlot0(key.toId());
        (Zones memory z, bool gIsC0) = _zones(gpuId, key);
        (Placement memory p, bool ok) = _planBid(key, z, gIsC0, tick, available);
        if (!ok) return false;
        poolManager.unlock(abi.encode(ACTION_DEPLOY, key, gpuId, p, gIsC0));
        return true;
    }

    /// @notice Places staged GPU inventory as an ask band. Permissionless;
    ///         returns false when the pool is priced past the whole ask band
    ///         (inventory stays staged — placing would sell below market).
    function placeAskFromInventory(bytes32 gpuId) external nonReentrant returns (bool placed) {
        if (issuance == address(0) || hook == address(0)) revert RefsIncomplete();
        uint256 amount = gpuInventory[gpuId];
        if (amount == 0) return false;
        PoolKey memory key = _poolKey(gpuId);
        if (GPUHook(hook).poolGpuId(key.toId()) == bytes32(0)) return false;
        (, int24 tick,,) = IPoolManager(poolManager).getSlot0(key.toId());
        (Zones memory z, bool gIsC0) = _zones(gpuId, key);
        (Placement memory p, bool ok) = _planAsk(key, z, gIsC0, tick, amount);
        if (!ok) return false;
        poolManager.unlock(abi.encode(ACTION_PLACE_ASK, key, gpuId, p, gIsC0));
        return true;
    }

    /// @notice Removes stale bands (ranges no longer overlapping the current
    ///         oracle-anchored target zones) and redeploys the recovered
    ///         inventory around the fresh reference: gUSD -> bid band, GPU ->
    ///         ask band. Permissionless but drift-gated: reverts
    ///         `NothingToRecenter` when nothing is stale. Removal is not a
    ///         swap — nobody transacts at the stale prices; the redeploy
    ///         re-prices the same real inventory around the current oracle.
    /// @param maxBands cap per call (processes the OLDEST stale bands first);
    ///        0 processes all stale bands.
    /// @return removed count of bands removed.
    function recenter(bytes32 gpuId, uint256 maxBands) external nonReentrant returns (uint256 removed) {
        return _recenter(gpuId, maxBands, false);
    }

    /// @notice Owner override: removes up to `maxBands` bands regardless of
    ///         staleness. For emergency inventory recycling only.
    function recenter(bytes32 gpuId, uint256 maxBands, bool force) external onlyOwner nonReentrant returns (uint256) {
        return _recenter(gpuId, maxBands, force);
    }

    /// @notice Flushes accumulated gUSD LP fees to the revenue ledger (GPU
    ///         fees go to ask-side inventory). Permissionless. Optionally
    ///         bounded to the half-open band range [from, to).
    function collect(bytes32 gpuId) external nonReentrant {
        _collect(gpuId, 0, _bands[gpuId].length);
    }

    function collect(bytes32 gpuId, uint256 from, uint256 to) external nonReentrant {
        if (to > _bands[gpuId].length || from > to) revert BandRangeInvalid();
        _collect(gpuId, from, to);
    }

    // --------------------------------------------------------------- views

    /// @notice Total gUSD currently held inside the POL's bands, computed
    ///         live from the pool's current tick — the honest bid-side depth.
    ///         0 when refs are unset or the pool is uninitialized.
    function bidDepth(bytes32 gpuId) external view returns (uint256 depth) {
        if (issuance == address(0) || hook == address(0)) return 0;
        PoolKey memory key = _poolKey(gpuId);
        (uint160 sqrtP, int24 tick,,) = IPoolManager(poolManager).getSlot0(key.toId());
        if (sqrtP == 0) return 0;
        Band[] storage bands = _bands[gpuId];
        uint256 len = bands.length;
        for (uint256 i; i < len; ++i) {
            (uint128 liq,,) =
                IPoolManager(poolManager).getPositionInfo(key.toId(), address(this), bands[i].tickLower, bands[i].tickUpper, 0);
            if (liq == 0) continue;
            (uint256 gusdHeld,) = _bandHoldings(key, liq, bands[i].tickLower, bands[i].tickUpper, tick);
            depth += gusdHeld;
        }
    }

    function bandCount(bytes32 gpuId) external view returns (uint256) {
        return _bands[gpuId].length;
    }

    /// @notice Placement dust: gUSD too small to place at the target band,
    ///         carried into the next deployment. Exposed so offchain custody
    ///         checks can reconcile the POL's gUSD balance exactly:
    ///         `balance == pendingPrincipal + residualOf + feesPendingGusd`.
    function residualOf(bytes32 gpuId) external view returns (uint256) {
        return _residual[gpuId];
    }

    function bandRange(bytes32 gpuId, uint256 index) external view returns (int24 tickLower, int24 tickUpper) {
        if (index >= _bands[gpuId].length) revert BandIndexOutOfRange();
        Band storage b = _bands[gpuId][index];
        return (b.tickLower, b.tickUpper);
    }

    /// @notice Live band snapshot: liquidity, current gUSD/GPU holdings,
    ///         placement bookkeeping, and raw fee growth for offchain fee
    ///         estimation. Reverts BandIndexOutOfRange past the end.
    function bandView(bytes32 gpuId, uint256 index)
        external
        view
        returns (
            uint128 liquidity,
            uint256 gusdHeld,
            uint256 gpuHeld,
            uint256 gusdPlaced,
            uint256 gpuPlaced,
            uint256 feeGrowthInside0X128,
            uint256 feeGrowthInside1X128
        )
    {
        if (issuance == address(0) || hook == address(0)) revert RefsIncomplete();
        Band[] storage bands = _bands[gpuId];
        if (index >= bands.length) revert BandIndexOutOfRange();
        Band storage b = bands[index];
        PoolKey memory key = _poolKey(gpuId);
        PoolId poolId = key.toId();
        (liquidity,,) = IPoolManager(poolManager).getPositionInfo(poolId, address(this), b.tickLower, b.tickUpper, 0);
        (uint160 sqrtP, int24 tick,,) = IPoolManager(poolManager).getSlot0(poolId);
        if (sqrtP != 0 && liquidity > 0) {
            (gusdHeld, gpuHeld) = _bandHoldings(key, liquidity, b.tickLower, b.tickUpper, tick);
        }
        gusdPlaced = b.gusdPlaced;
        gpuPlaced = b.gpuPlaced;
        (feeGrowthInside0X128, feeGrowthInside1X128) = IPoolManager(poolManager).getFeeGrowthInside(poolId, b.tickLower, b.tickUpper);
    }

    // ----------------------------------------------------------- callbacks

    function _unlockCallback(bytes calldata data) internal override returns (bytes memory) {
        uint8 action = uint8(data[31]); // abi uint8 is right-aligned in its word
        if (action == ACTION_DEPLOY || action == ACTION_PLACE_ASK) {
            (, PoolKey memory key, bytes32 gpuId, Placement memory p, bool gIsC0) =
                abi.decode(data, (uint8, PoolKey, bytes32, Placement, bool));
            _placeCallback(key, gpuId, p, gIsC0, action == ACTION_DEPLOY);
            return "";
        }
        if (action == ACTION_RECENTER) {
            (, PoolKey memory key, RecenterPlan memory plan) = abi.decode(data, (uint8, PoolKey, RecenterPlan));
            (uint256 gusdRecovered, uint256 gpuRecovered) = _recenterCallback(key, plan);
            return abi.encode(gusdRecovered, gpuRecovered);
        }
        // ACTION_COLLECT
        (, PoolKey memory key, bytes32 gpuId, uint256 from, uint256 to, bool gIsC0) =
            abi.decode(data, (uint8, PoolKey, bytes32, uint256, uint256, bool));
        (uint256 gusdFees, uint256 gpuFees) = _collectCallback(key, gpuId, from, to, gIsC0);
        return abi.encode(gusdFees, gpuFees);
    }

    /// @dev Adds `p` from POL custody: gUSD from pending principal (bid) or
    ///      GPU from staged inventory (ask). A pre-existing live position at
    ///      the same range (merge) is poked first so the placement delta is
    ///      pure principal and exactly assertable.
    function _placeCallback(PoolKey memory key, bytes32 gpuId, Placement memory p, bool gIsC0, bool bidSide) internal {
        _pokeIfPositionExists(key, p.tickLower, p.tickUpper, gpuId);
        if (bidSide) {
            uint256 available = pendingPrincipal[gpuId] + _residual[gpuId];
            if (p.required > available) revert UnexpectedDelta(); // stale plan
            _settleGusd(p.required);
            BalanceDelta delta = _add(key, p);
            _assertPrincipalDelta(delta, p.required, gIsC0, true);
            _bookBand(gpuId, p, p.required, 0);
            pendingPrincipal[gpuId] = 0;
            _residual[gpuId] = available - p.required;
            emit BandPlaced(gpuId, key.toId(), p.tickLower, p.tickUpper, p.liquidity, p.required, 0, true);
        } else {
            uint256 staged = gpuInventory[gpuId];
            if (p.required > staged) revert UnexpectedDelta(); // stale plan
            _settleGpu(key, p.required);
            BalanceDelta delta = _add(key, p);
            _assertPrincipalDelta(delta, p.required, gIsC0, false);
            _bookBand(gpuId, p, 0, p.required);
            gpuInventory[gpuId] = staged - p.required;
            emit BandPlaced(gpuId, key.toId(), p.tickLower, p.tickUpper, p.liquidity, 0, p.required, false);
        }
    }

    /// @dev Removes every selected band, then redeploys the recovered
    ///      inventory around the fresh reference inside the same unlock:
    ///      recovered gUSD -> bid band, recovered GPU -> ask band. The
    ///      recovered amounts sit as manager credit while the redeploy debits
    ///      them; everything unplaceable is taken out to pending/inventory
    ///      (recovered gUSD is NOT re-counted in `principalContributed` —
    ///      provenance is preserved). Fee sweeps are self-funded: each poke's
    ///      `feesAccrued` credit exactly covers its take, so the recovered
    ///      amounts are pure principal and the credit nets to exactly zero.
    function _recenterCallback(PoolKey memory key, RecenterPlan memory plan)
        internal
        returns (uint256 gusdRecovered, uint256 gpuRecovered)
    {
        (gusdRecovered, gpuRecovered) = _removeStaleBands(key, plan);
        uint256 left = _redeployGusd(key, plan, gusdRecovered);
        if (left > 0) {
            poolManager.take(_gusdCurrency(key, plan.gIsC0), address(this), left);
            pendingPrincipal[plan.gpuId] += left; // NOT re-counted in principalContributed
        }
        left = _redeployGpu(key, plan, gpuRecovered);
        if (left > 0) {
            poolManager.take(_gpuCurrency(key, plan.gIsC0), address(this), left);
            gpuInventory[plan.gpuId] += left;
        }
    }

    /// @dev Removes the selected bands: poke (fees -> the Option A channels)
    ///      when a live position exists, then remove to zero — the returned
    ///      delta is pure recovered principal.
    function _removeStaleBands(PoolKey memory key, RecenterPlan memory plan)
        internal
        returns (uint256 gusdRecovered, uint256 gpuRecovered)
    {
        for (uint256 i; i < plan.count; ++i) {
            int24 lo = plan.lows[i];
            int24 hi = plan.highs[i];
            (uint128 liq,,) = IPoolManager(poolManager).getPositionInfo(key.toId(), address(this), lo, hi, 0);
            if (liq == 0) {
                _removeBandEntry(plan.gpuId, lo, hi);
                continue;
            }
            _pokeIfPositionExists(key, lo, hi, plan.gpuId);
            BalanceDelta removed = _removeAll(key, lo, hi, liq);
            if (removed.amount0() < 0 || removed.amount1() < 0) revert UnexpectedDelta();
            uint256 recGusd = plan.gIsC0 ? uint128(removed.amount0()) : uint128(removed.amount1());
            uint256 recGpu = plan.gIsC0 ? uint128(removed.amount1()) : uint128(removed.amount0());
            gusdRecovered += recGusd;
            gpuRecovered += recGpu;
            _removeBandEntry(plan.gpuId, lo, hi);
            emit BandRemoved(plan.gpuId, key.toId(), lo, hi, recGusd, recGpu);
        }
    }

    /// @dev Redeploys recovered gUSD as the fresh bid band (merge-aware); a
    ///      pre-existing live position at the range is poked first so the
    ///      placement delta is pure principal. Returns the unplaceable
    ///      remainder (deferred placement -> back to pendingPrincipal).
    function _redeployGusd(PoolKey memory key, RecenterPlan memory plan, uint256 recovered)
        internal
        returns (uint256 left)
    {
        left = recovered;
        if (!plan.placeBid || left == 0) return left;
        _pokeIfPositionExists(key, plan.bidLo, plan.bidHi, plan.gpuId);
        (Placement memory p, bool ok) = _liquidityForGusd(plan.gIsC0, plan.bidLo, plan.bidHi, left);
        if (ok) {
            BalanceDelta delta = _add(key, p);
            _assertPrincipalDelta(delta, p.required, plan.gIsC0, true);
            _bookBand(plan.gpuId, p, p.required, 0);
            left -= p.required;
            emit BandPlaced(plan.gpuId, key.toId(), p.tickLower, p.tickUpper, p.liquidity, p.required, 0, true);
        }
    }

    /// @dev Mirror of _redeployGusd for recovered GPU -> ask band; unplaceable
    ///      remainder returns to staged inventory.
    function _redeployGpu(PoolKey memory key, RecenterPlan memory plan, uint256 recovered)
        internal
        returns (uint256 left)
    {
        left = recovered;
        if (!plan.placeAsk || left == 0) return left;
        _pokeIfPositionExists(key, plan.askLo, plan.askHi, plan.gpuId);
        (Placement memory p, bool ok) = _liquidityForGpu(plan.gIsC0, plan.askLo, plan.askHi, left);
        if (ok) {
            BalanceDelta delta = _add(key, p);
            _assertPrincipalDelta(delta, p.required, plan.gIsC0, false);
            _bookBand(plan.gpuId, p, 0, p.required);
            left -= p.required;
            emit BandPlaced(plan.gpuId, key.toId(), p.tickLower, p.tickUpper, p.liquidity, 0, p.required, false);
        }
    }

    // ------------------------------------------------------------ internal

    function _recenter(bytes32 gpuId, uint256 maxBands, bool force) internal returns (uint256 removed) {
        if (issuance == address(0) || hook == address(0)) revert RefsIncomplete();
        Band[] storage bands = _bands[gpuId];
        uint256 len = bands.length;
        if (len == 0) revert NothingToRecenter();
        PoolKey memory key = _poolKey(gpuId);
        (, int24 tick,,) = IPoolManager(poolManager).getSlot0(key.toId());
        (Zones memory z, bool gIsC0) = _zones(gpuId, key);
        // select stale bands oldest-first (array order); force bypasses the gate
        uint256 cap = maxBands == 0 || maxBands > len ? len : maxBands;
        RecenterPlan memory plan;
        plan.gpuId = gpuId;
        plan.lows = new int24[](cap);
        plan.highs = new int24[](cap);
        for (uint256 i; i < len && plan.count < cap; ++i) {
            if (force || _isStale(bands[i].tickLower, bands[i].tickUpper, z)) {
                plan.lows[plan.count] = bands[i].tickLower;
                plan.highs[plan.count] = bands[i].tickUpper;
                ++plan.count;
            }
        }
        if (plan.count == 0) revert NothingToRecenter();
        (plan.bidLo, plan.bidHi, plan.placeBid) = _bidRange(key, z, gIsC0, tick);
        (plan.askLo, plan.askHi, plan.placeAsk) = _askRange(key, z, gIsC0, tick);
        plan.gIsC0 = gIsC0;
        bytes memory ret = poolManager.unlock(abi.encode(ACTION_RECENTER, key, plan));
        (uint256 gusdRecovered, uint256 gpuRecovered) = abi.decode(ret, (uint256, uint256));
        emit Recentred(gpuId, plan.count, gusdRecovered, gpuRecovered);
        return plan.count;
    }

    function _collect(bytes32 gpuId, uint256 from, uint256 to) internal {
        if (from == to) return;
        PoolKey memory key = _poolKey(gpuId);
        bool gIsC0 = GpuPoolKey.gusdIsCurrency0(key, address(gUSD));
        bytes memory ret = poolManager.unlock(abi.encode(ACTION_COLLECT, key, gpuId, from, to, gIsC0));
        (uint256 gusdFees, uint256 gpuFees) = abi.decode(ret, (uint256, uint256));
        if (gpuFees > 0) gpuInventory[gpuId] += gpuFees;
        uint256 flush = feesPendingGusd[gpuId] + gusdFees;
        if (flush > 0) {
            feesPendingGusd[gpuId] = 0;
            IERC20(address(gUSD)).safeTransfer(revenueLedger, flush);
        }
        if (flush > 0 || gpuFees > 0) emit FeesCollected(gpuId, flush, gpuFees);
    }

    /// @dev Pokes every band in [from, to) that still holds liquidity (a
    ///      zero-liquidity position cannot be poked), accumulating the
    ///      returned fee amounts. Batched take at the end.
    function _collectCallback(PoolKey memory key, bytes32 gpuId, uint256 from, uint256 to, bool gIsC0)
        internal
        returns (uint256 gusdFees, uint256 gpuFees)
    {
        Band[] storage bands = _bands[gpuId];
        for (uint256 i = from; i < to; ++i) {
            Band storage b = bands[i];
            (uint128 liq,,) = IPoolManager(poolManager).getPositionInfo(key.toId(), address(this), b.tickLower, b.tickUpper, 0);
            if (liq == 0) continue;
            (BalanceDelta fees,) =
                IPoolManager(poolManager).modifyLiquidity(key, _pokeParams(b.tickLower, b.tickUpper), "");
            if (fees.amount0() < 0 || fees.amount1() < 0) revert UnexpectedDelta();
            gusdFees += gIsC0 ? uint128(fees.amount0()) : uint128(fees.amount1());
            gpuFees += gIsC0 ? uint128(fees.amount1()) : uint128(fees.amount0());
        }
        if (gusdFees > 0) poolManager.take(_gusdCurrency(key, gIsC0), address(this), gusdFees);
        if (gpuFees > 0) poolManager.take(_gpuCurrency(key, gIsC0), address(this), gpuFees);
    }

    // -------------------------------------------------- placement geometry

    /// @dev Oracle-anchored target zones in pool-tick space, clamped to the
    ///      representable tick range. The reference is the guarded oracle
    ///      view — reverts on a stale oracle — marked up by the issuance fee
    ///      to form the ask edge; the bid zone sits `spread` ticks from the
    ///      ask edge on the side where gUSD is held.
    function _zones(bytes32 gpuId, PoolKey memory key) internal view returns (Zones memory z, bool gIsC0) {
        gIsC0 = GpuPoolKey.gusdIsCurrency0(key, address(gUSD));
        uint256 refSqrt = IGPUIssuance(issuance).referenceSqrtPriceX96(gpuId); // guarded: stale oracle reverts
        uint16 feeBps = IGPUIssuance(issuance).feeBpsOf(gpuId);
        int24 width = IGPUIssuance(issuance).bandWidthOf(gpuId);
        int24 spread = IGPUIssuance(issuance).bandSpreadTicksOf(gpuId);
        // issuance ask = oracle reference marked up by exactly the issuance
        // fee: h_ask = h_ref x (1 + feeBps/1e4). sqrt(h_ask) = refSqrt x
        // sqrt(1 + feeBps/1e4) (multiplying the sqrt by (1+b) would mark the
        // PRICE up by (1+b)^2 — double the fee). The pool tick at that ask is
        // tick(h_ask) when gUSD is currency1 (pool price = h) and its
        // negation when gUSD is currency0 (pool price = 1/h).
        uint256 sqrtAsk = (refSqrt * FixedPointMathLib.sqrt(uint256(10_000 + feeBps) * 1e18 / 10_000)) / 1e9;
        if (sqrtAsk > type(uint160).max) revert OraclePriceRange();
        int24 tAsk = TickMath.getTickAtSqrtPrice(uint160(sqrtAsk));
        if (gIsC0) tAsk = -tAsk;
        if (gIsC0) {
            // tick falls as the GPU price rises: bids above the ask tick,
            // asks below it
            z.bidLo = _clampTick(tAsk + spread);
            z.bidHi = _clampTick(tAsk + spread + width);
            z.askHi = tAsk;
            z.askLo = _clampTick(tAsk - width);
        } else {
            z.bidHi = _clampTick(tAsk - spread);
            z.bidLo = _clampTick(tAsk - spread - width);
            z.askLo = tAsk;
            z.askHi = _clampTick(tAsk + width);
        }
    }

    function _clampTick(int24 t) internal pure returns (int24) {
        if (t < TickMath.MIN_TICK) return TickMath.MIN_TICK;
        if (t > TickMath.MAX_TICK) return TickMath.MAX_TICK;
        return t;
    }

    /// @dev Geometry-only bid-band target. Anchor: the pool tick sits below
    ///      the zone (place at the oracle anchor — the stale-expensive drain
    ///      fix). Clamp: the pool sits inside the zone (the one spot-informed
    ///      case — place just above the current tick). Defer: the pool is
    ///      priced past the whole zone (bids would sell gUSD above market).
    function _bidRange(PoolKey memory key, Zones memory z, bool gIsC0, int24 tick)
        internal
        pure
        returns (int24 lo, int24 hi, bool ok)
    {
        int24 w = z.bidHi - z.bidLo;
        if (gIsC0) {
            if (tick < z.bidLo) {
                lo = _alignUp(z.bidLo, key.tickSpacing);
            } else if (tick < z.bidHi) {
                lo = _alignUp(tick, key.tickSpacing);
            } else {
                return (0, 0, false);
            }
            hi = lo + w;
        } else {
            if (tick >= z.bidHi) {
                hi = _alignDown(z.bidHi, key.tickSpacing);
            } else if (tick > z.bidLo) {
                hi = _alignDown(tick, key.tickSpacing);
            } else {
                return (0, 0, false);
            }
            lo = hi - w;
        }
        if (lo < TickMath.MIN_TICK || hi > TickMath.MAX_TICK) return (0, 0, false);
        ok = true;
    }

    /// @dev Geometry-only ask-band target (mirror of _bidRange): anchor at
    ///      the zone edge when the pool is on the correct side, clamp when
    ///      inside, defer (stage the GPU) when the pool is priced past the
    ///      whole zone — asks would sell below market.
    function _askRange(PoolKey memory key, Zones memory z, bool gIsC0, int24 tick)
        internal
        pure
        returns (int24 lo, int24 hi, bool ok)
    {
        int24 w = z.askHi - z.askLo;
        if (gIsC0) {
            if (tick >= z.askHi) {
                hi = _alignDown(z.askHi, key.tickSpacing);
            } else if (tick >= z.askLo) {
                hi = _alignDown(tick, key.tickSpacing);
            } else {
                return (0, 0, false);
            }
            lo = hi - w;
        } else {
            if (tick < z.askLo) {
                lo = _alignUp(z.askLo, key.tickSpacing);
            } else if (tick < z.askHi) {
                lo = _alignUp(tick, key.tickSpacing);
            } else {
                return (0, 0, false);
            }
            hi = lo + w;
        }
        if (lo < TickMath.MIN_TICK || hi > TickMath.MAX_TICK) return (0, 0, false);
        ok = true;
    }

    /// @dev Full bid placement plan: geometry + amount math.
    function _planBid(PoolKey memory key, Zones memory z, bool gIsC0, int24 tick, uint256 available)
        internal
        pure
        returns (Placement memory p, bool ok)
    {
        (int24 lo, int24 hi, bool geomOk) = _bidRange(key, z, gIsC0, tick);
        if (!geomOk) return (p, false);
        return _liquidityForGusd(gIsC0, lo, hi, available);
    }

    /// @dev Full ask placement plan (mirror of _planBid).
    function _planAsk(PoolKey memory key, Zones memory z, bool gIsC0, int24 tick, uint256 available)
        internal
        pure
        returns (Placement memory p, bool ok)
    {
        (int24 lo, int24 hi, bool geomOk) = _askRange(key, z, gIsC0, tick);
        if (!geomOk) return (p, false);
        return _liquidityForGpu(gIsC0, lo, hi, available);
    }

    /// @dev Floors liquidity from `available` gUSD and returns the exact
    ///      rounded-up principal the manager will debit. Single-sided by
    ///      construction: the planned band is never strictly inside the
    ///      current tick, solvency: floor L from available, required =
    ///      ceil ≤ available by construction.
    function _liquidityForGusd(bool gIsC0, int24 lo, int24 hi, uint256 available)
        internal
        pure
        returns (Placement memory p, bool ok)
    {
        uint160 sl = TickMath.getSqrtPriceAtTick(lo);
        uint160 sh = TickMath.getSqrtPriceAtTick(hi);
        if (gIsC0) {
            p.liquidity = LiquidityAmounts.getLiquidityForAmount0(sl, sh, available);
            if (p.liquidity == 0) return (p, false);
            p.required = SqrtPriceMath.getAmount0Delta(sl, sh, p.liquidity, true);
        } else {
            p.liquidity = LiquidityAmounts.getLiquidityForAmount1(sl, sh, available);
            if (p.liquidity == 0) return (p, false);
            p.required = SqrtPriceMath.getAmount1Delta(sl, sh, p.liquidity, true);
        }
        if (p.required == 0 || p.required > available) return (p, false);
        p.tickLower = lo;
        p.tickUpper = hi;
        ok = true;
    }

    /// @dev Floors liquidity from `available` GPU (inventory) — mirror of
    ///      _liquidityForGusd for the GPU-denominated side.
    function _liquidityForGpu(bool gIsC0, int24 lo, int24 hi, uint256 available)
        internal
        pure
        returns (Placement memory p, bool ok)
    {
        uint160 sl = TickMath.getSqrtPriceAtTick(lo);
        uint160 sh = TickMath.getSqrtPriceAtTick(hi);
        if (gIsC0) {
            p.liquidity = LiquidityAmounts.getLiquidityForAmount1(sl, sh, available);
            if (p.liquidity == 0) return (p, false);
            p.required = SqrtPriceMath.getAmount1Delta(sl, sh, p.liquidity, true);
        } else {
            p.liquidity = LiquidityAmounts.getLiquidityForAmount0(sl, sh, available);
            if (p.liquidity == 0) return (p, false);
            p.required = SqrtPriceMath.getAmount0Delta(sl, sh, p.liquidity, true);
        }
        if (p.required == 0) return (p, false);
        p.tickLower = lo;
        p.tickUpper = hi;
        ok = true;
    }

    // -------------------------------------------------- custody + v4 calls

    /// @dev Sweeps a fee-only delta into the two-currency accounting: gUSD
    ///      fees accrue to the revenue ledger (flushed by `collect`), GPU
    ///      fees to ask-side inventory. Takes both out of the manager.
    ///      Returns the orientation-mapped amounts.
    function _sweepFees(PoolKey memory key, BalanceDelta fees, bytes32 gpuId)
        internal
        returns (uint256 gusdFees, uint256 gpuFees)
    {
        if (fees.amount0() < 0 || fees.amount1() < 0) revert UnexpectedDelta();
        bool gIsC0 = GpuPoolKey.gusdIsCurrency0(key, address(gUSD));
        gusdFees = gIsC0 ? uint128(fees.amount0()) : uint128(fees.amount1());
        gpuFees = gIsC0 ? uint128(fees.amount1()) : uint128(fees.amount0());
        if (gusdFees > 0) {
            poolManager.take(_gusdCurrency(key, gIsC0), address(this), gusdFees);
            feesPendingGusd[gpuId] += gusdFees;
        }
        if (gpuFees > 0) {
            poolManager.take(_gpuCurrency(key, gIsC0), address(this), gpuFees);
            gpuInventory[gpuId] += gpuFees;
        }
    }

    /// @dev Zero-delta poke on an existing live position only (a zero-
    ///      liquidity position reverts CannotUpdateEmptyPosition). Returns
    ///      the swept fee amounts (both taken out of the manager).
    function _pokeIfPositionExists(PoolKey memory key, int24 lo, int24 hi, bytes32 gpuId)
        internal
        returns (uint256 gusdFees, uint256 gpuFees)
    {
        (uint128 liq,,) = IPoolManager(poolManager).getPositionInfo(key.toId(), address(this), lo, hi, 0);
        if (liq == 0) return (0, 0);
        (BalanceDelta fees,) = IPoolManager(poolManager).modifyLiquidity(key, _pokeParams(lo, hi), "");
        return _sweepFees(key, fees, gpuId);
    }

    function _pokeParams(int24 lo, int24 hi) internal pure returns (ModifyLiquidityParams memory) {
        return ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: 0, salt: 0});
    }

    function _add(PoolKey memory key, Placement memory p) internal returns (BalanceDelta) {
        (BalanceDelta delta,) = IPoolManager(poolManager).modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: p.tickLower, tickUpper: p.tickUpper, liquidityDelta: int256(uint256(p.liquidity)), salt: 0}),
            ""
        );
        return delta;
    }

    function _removeAll(PoolKey memory key, int24 lo, int24 hi, uint128 liq) internal returns (BalanceDelta) {
        (BalanceDelta delta,) = IPoolManager(poolManager).modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: -int256(uint256(liq)), salt: 0}),
            ""
        );
        return delta;
    }

    /// @dev Asserts the placement delta is exactly -required in the owed
    ///      currency and 0 in the other — single-sided, fee-free (the range
    ///      was poked first), no hook delta (GPUHook has no liquidity hooks).
    function _assertPrincipalDelta(BalanceDelta delta, uint256 required, bool gIsC0, bool gusdSide) internal pure {
        if (required > uint256(uint128(type(int128).max))) revert UnexpectedDelta();
        int128 neg = -int128(uint128(required));
        bool owedIsC0 = gusdSide ? gIsC0 : !gIsC0;
        if (owedIsC0) {
            if (delta.amount0() != neg || delta.amount1() != 0) revert UnexpectedDelta();
        } else {
            if (delta.amount1() != neg || delta.amount0() != 0) revert UnexpectedDelta();
        }
    }

    function _settleGusd(uint256 amount) internal {
        Currency c = Currency.wrap(address(gUSD));
        IPoolManager(poolManager).sync(c);
        CurrencyLibrary.transfer(c, address(poolManager), amount);
        IPoolManager(poolManager).settle();
    }

    function _settleGpu(PoolKey memory key, uint256 amount) internal {
        Currency c = _gpuCurrency(key, GpuPoolKey.gusdIsCurrency0(key, address(gUSD)));
        IPoolManager(poolManager).sync(c);
        CurrencyLibrary.transfer(c, address(poolManager), amount);
        IPoolManager(poolManager).settle();
    }

    // ------------------------------------------------------- bookkeeping

    /// @dev Appends or merges (identical range, salt 0) the placement into
    ///      the band list. Merging keeps the ladder compact when the
    ///      reference is stable.
    function _bookBand(bytes32 gpuId, Placement memory p, uint256 gusdPlaced, uint256 gpuPlaced) internal {
        Band[] storage bands = _bands[gpuId];
        uint256 len = bands.length;
        for (uint256 i; i < len; ++i) {
            if (bands[i].tickLower == p.tickLower && bands[i].tickUpper == p.tickUpper) {
                bands[i].liquidity += p.liquidity;
                bands[i].gusdPlaced += gusdPlaced;
                bands[i].gpuPlaced += gpuPlaced;
                return;
            }
        }
        bands.push(Band({tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: p.liquidity, gusdPlaced: gusdPlaced, gpuPlaced: gpuPlaced}));
    }

    /// @dev Swap-and-pop removal from the band list (order of the rest is
    ///      preserved; order within a recenter batch was already snapshotted).
    function _removeBandEntry(bytes32 gpuId, int24 lo, int24 hi) internal {
        Band[] storage bands = _bands[gpuId];
        uint256 len = bands.length;
        for (uint256 i; i < len; ++i) {
            if (bands[i].tickLower == lo && bands[i].tickUpper == hi) {
                bands[i] = bands[len - 1];
                bands.pop();
                return;
            }
        }
    }

    function _poolKey(bytes32 gpuId) internal view returns (PoolKey memory key) {
        IGPUIssuance.PoolParams memory pp = IGPUIssuance(issuance).poolParamsOf(gpuId); // reverts UnknownGpuId
        address gpuToken = IGPUIssuance(issuance).tokenOf(gpuId);
        key = GpuPoolKey.canonical(address(gUSD), gpuToken, pp, IHooks(hook));
    }

    /// @dev Stale = the band's range overlaps NEITHER current target zone
    ///      (zones are clamped to the representable tick range). Removal is
    ///      not a swap — nobody transacts at the stale prices.
    function _isStale(int24 bLo, int24 bHi, Zones memory z) internal pure returns (bool) {
        bool bidOverlap = bLo <= z.bidHi && bHi >= z.bidLo;
        bool askOverlap = bLo <= z.askHi && bHi >= z.askLo;
        return !(bidOverlap || askOverlap);
    }

    /// @dev Live holdings of a single-sided-or-mixed band at the pool's
    ///      current tick, orientation-aware.
    function _bandHoldings(PoolKey memory key, uint128 L, int24 lo, int24 hi, int24 tick)
        internal
        view
        returns (uint256 gusdHeld, uint256 gpuHeld)
    {
        bool gIsC0 = GpuPoolKey.gusdIsCurrency0(key, address(gUSD));
        uint160 sl = TickMath.getSqrtPriceAtTick(lo);
        uint160 sh = TickMath.getSqrtPriceAtTick(hi);
        if (gIsC0) {
            if (tick < lo) {
                return (SqrtPriceMath.getAmount0Delta(sl, sh, L, false), 0);
            }
            if (tick >= hi) {
                return (0, SqrtPriceMath.getAmount1Delta(sl, sh, L, false));
            }
            uint160 st = TickMath.getSqrtPriceAtTick(tick);
            return (
                SqrtPriceMath.getAmount0Delta(st, sh, L, false),
                SqrtPriceMath.getAmount1Delta(sl, st, L, false)
            );
        } else {
            if (tick < lo) {
                return (0, SqrtPriceMath.getAmount0Delta(sl, sh, L, false));
            }
            if (tick >= hi) {
                return (SqrtPriceMath.getAmount1Delta(sl, sh, L, false), 0);
            }
            uint160 st = TickMath.getSqrtPriceAtTick(tick);
            return (
                SqrtPriceMath.getAmount1Delta(sl, st, L, false),
                SqrtPriceMath.getAmount0Delta(st, sh, L, false)
            );
        }
    }

    function _gusdCurrency(PoolKey memory key, bool gIsC0) internal pure returns (Currency) {
        return gIsC0 ? key.currency0 : key.currency1;
    }

    function _gpuCurrency(PoolKey memory key, bool gIsC0) internal pure returns (Currency) {
        return gIsC0 ? key.currency1 : key.currency0;
    }

    // ------------------------------------------------------ tick alignment

    /// @dev Smallest multiple of `s` that is >= t (Solidity % takes the
    ///      dividend's sign, so negative ticks need both branches).
    function _alignUp(int24 t, int24 s) internal pure returns (int24) {
        int24 r = t % s;
        if (r > 0) return t + (s - r);
        if (r < 0) return t - r;
        return t;
    }

    /// @dev Largest multiple of `s` that is <= t.
    function _alignDown(int24 t, int24 s) internal pure returns (int24) {
        int24 r = t % s;
        return r < 0 ? t - r - s : t - r;
    }
}
