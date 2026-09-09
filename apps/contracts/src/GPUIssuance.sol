// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";
import {GPUToken} from "./GPUToken.sol";
import {GpuId} from "./libraries/GpuId.sol";
import {IGPUPriceOracle} from "./oracle/IGPUPriceOracle.sol";
import {IGPUIssuance} from "./interfaces/IGPUIssuance.sol";
import {IMarketLiquidity} from "./interfaces/IMarketLiquidity.sol";

/// @title GPUIssuance — permissionless primary market for GPU-hour claims.
/// @notice Users pay gUSD (oracle price + issuance fee) and mint GPU tokens.
///         The base payment is forwarded to GPUMarketLiquidity, where it
///         progressively capitalizes the GPU's canonical market as bid-side
///         liquidity around the oracle reference. There is no NAV redemption
///         and no withdrawal path anywhere: principal exits only as market
///         trades. Issuance never touches the pool — placement is a separate
///         permissionless step, so a v4 problem can never fail a primary buy.
/// @dev    Issuance composition (all coordination-fixed, see IGPUPriceOracle):
///         base(6dec gUSD) = amount(18dec) * price(4dec) / 10^16, Ceil.
///         Worked example: 100 H100 @ 2.5000 -> 100e18 * 25_000 / 1e16
///         = 250_000_000 = 250.000000 gUSD.
///         The 4-decimal price convention is ENFORCED at construction: the
///         wired oracle must report `PRICE_SCALE() == PRICE_SCALE`, or
///         deployment reverts — a scale mismatch would otherwise misprice
///         every issuance silently. The composition divisor is derived from
///         the oracle's own scale, never re-declared as a literal.
contract GPUIssuance is IGPUIssuance, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_ISSUANCE_FEE_BPS = 1_000; // 10%
    uint256 public constant PRICE_SCALE = 10_000; // 4-decimal fixed point (coordination-fixed)

    // 10^(gpusDecimals 18 + priceDecimals 4 - gusdDecimals 6), derived from
    // the oracle's PRICE_SCALE in the constructor (== 1e16 for 4 decimals)
    uint256 public immutable compositionDivisor;

    struct GpuConfig {
        address token;
        bool enabled;
        uint16 feeBps;
        uint24 fee; // canonical v4 pool fee
        int24 tickSpacing;
        uint256 totalIssued;
    }

    IERC20 public immutable gUSD;
    IGPUPriceOracle public immutable oracle;
    address public immutable revenueLedger;
    address public immutable marketLiquidity;

    uint256 public maxOracleStaleness = 25 hours;

    mapping(bytes32 => GpuConfig) internal _gpus;
    mapping(address => bytes32) internal _gpuIdOfToken;
    bytes32[] internal _gpuIds;

    error UnknownGpuId();
    error GpuAlreadyExists();
    error IssuanceDisabled();
    error OraclePriceZero();
    error OracleStale();
    error OracleFutureTimestamp();
    error OraclePriceRange();
    error ZeroAmount();
    error ZeroAddress();
    error FeeTooLarge();
    error PriceScaleMismatch();
    error InsufficientSpend();
    error NotHook();

    event GpuCreated(bytes32 indexed gpuId, address token, uint16 feeBps, uint24 poolFee, int24 tickSpacing);
    event Issued(
        address indexed caller, bytes32 indexed gpuId, address indexed to, uint256 amount, uint256 base, uint256 fee
    );
    event IssuanceEnabledSet(bytes32 indexed gpuId, bool enabled);
    event IssuanceFeeSet(bytes32 indexed gpuId, uint16 feeBps);
    event MaxOracleStalenessSet(uint256 seconds_);

    constructor(IERC20 gUSD_, IGPUPriceOracle oracle_, address revenueLedger_, address marketLiquidity_, address initialOwner)
        Ownable(initialOwner)
    {
        // The 4-decimal price convention is a coordination-fixed encoding
        // contract (IGPUPriceOracle). Enforce it here: a wired oracle built on
        // any other scale would misprice every issuance silently.
        uint256 oracleScale = oracle_.PRICE_SCALE();
        if (oracleScale != PRICE_SCALE) revert PriceScaleMismatch();
        if (marketLiquidity_ == address(0)) revert ZeroAddress();
        gUSD = gUSD_;
        oracle = oracle_;
        revenueLedger = revenueLedger_;
        marketLiquidity = marketLiquidity_;
        // 10^(gpusDecimals 18 + priceDecimals 4 - gusdDecimals 6), derived from
        // the oracle's own scale — never re-declared as a literal.
        compositionDivisor = Math.mulDiv(10 ** 18, oracleScale, 10 ** 6);
    }

    // ---------------------------------------------------------------- owner

    function createGpu(
        bytes32 gpuId,
        string calldata name,
        string calldata symbol,
        uint16 feeBps,
        uint24 fee,
        int24 tickSpacing
    ) external onlyOwner {
        GpuId.validate(gpuId);
        if (_gpus[gpuId].token != address(0)) revert GpuAlreadyExists();
        if (feeBps > MAX_ISSUANCE_FEE_BPS) revert FeeTooLarge();
        GPUToken token = new GPUToken{salt: gpuId}(address(this), gpuId, name, symbol);
        _gpus[gpuId] = GpuConfig({token: address(token), enabled: false, feeBps: feeBps, fee: fee, tickSpacing: tickSpacing, totalIssued: 0});
        _gpuIdOfToken[address(token)] = gpuId;
        _gpuIds.push(gpuId);
        emit GpuCreated(gpuId, address(token), feeBps, fee, tickSpacing);
    }

    function setIssuanceEnabled(bytes32 gpuId, bool enabled) external onlyOwner {
        _requireKnown(gpuId);
        _gpus[gpuId].enabled = enabled;
        emit IssuanceEnabledSet(gpuId, enabled);
    }

    function setIssuanceFee(bytes32 gpuId, uint16 feeBps) external onlyOwner {
        _requireKnown(gpuId);
        if (feeBps > MAX_ISSUANCE_FEE_BPS) revert FeeTooLarge();
        _gpus[gpuId].feeBps = feeBps;
        emit IssuanceFeeSet(gpuId, feeBps);
    }

    function setMaxOracleStaleness(uint256 seconds_) external onlyOwner {
        maxOracleStaleness = seconds_;
        emit MaxOracleStalenessSet(seconds_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------ issuance

    /// @notice Buys `amount` GPU tokens at the oracle price + issuance fee.
    ///         The base payment is forwarded to `marketLiquidity` (the POL),
    ///         where it capitalizes the GPU's canonical market as bid-side
    ///         liquidity around the oracle reference; the fee is protocol
    ///         revenue. No v4 interaction: placement is a separate
    ///         permissionless step, so a v4 problem can never fail a primary
    ///         buy.
    /// @return base gUSD paid as market capital (excludes fee).
    /// @return fee gUSD paid as issuance fee to the revenue ledger.
    function issue(bytes32 gpuId, uint256 amount, address to)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 base, uint256 fee)
    {
        if (amount == 0) revert ZeroAmount();
        GpuConfig storage cfg = _gpus[gpuId];
        if (cfg.token == address(0)) revert UnknownGpuId();
        if (!cfg.enabled) revert IssuanceDisabled();

        uint256 price = _oraclePrice(gpuId);

        base = Math.mulDiv(amount, price, compositionDivisor, Math.Rounding.Ceil);
        fee = Math.mulDiv(base, cfg.feeBps, 10_000, Math.Rounding.Ceil);

        // CEI: pull base + fee from the user, route both, mint last. Issuance
        // is fully decoupled from v4: placement (GPUMarketLiquidity
        // .deployPending) is a separate permissionless step, so a v4 problem
        // can never fail a primary buy. The principal is market capital, not
        // a redeemable reserve: it deepens the market it created.
        _gpus[gpuId].totalIssued += amount;
        gUSD.safeTransferFrom(msg.sender, address(this), base + fee);
        if (fee > 0) gUSD.safeTransfer(revenueLedger, fee);
        // principal -> market capital: the POL books it as pending and places
        // it as a bid band around the oracle reference
        gUSD.safeTransfer(marketLiquidity, base);
        IMarketLiquidity(marketLiquidity).notePrincipal(gpuId, base);
        GPUToken(cfg.token).mint(to, amount);

        emit Issued(msg.sender, gpuId, to, amount, base, fee);
    }

    /// @notice In-swap issuance backstop for GPUHook: pricing and guards are
    ///         identical to `issue()`, paid by transferFrom from the caller
    ///         (the hook, inside a PoolManager lock), minting to `to`.
    ///         Reverts when `base + fee > maxGusdSpend` — the hook absorbs
    ///         exactly what it plans to spend, so any divergence between the
    ///         plan-time quote and this execution (e.g. an oracle move by
    ///         reentrancy mid-swap) fails closed instead of bleeding capital.
    ///         Zero v4 interaction.
    function issueCredited(bytes32 gpuId, uint256 amount, address to, uint256 maxGusdSpend)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 base, uint256 fee)
    {
        // Hook-only mint authority: the in-swap backstop must be reachable
        // exclusively from the market hook inside a PoolManager lock. The
        // vault's hook ref is zero until setRefs — fail-closed either way.
        if (msg.sender != IMarketLiquidity(marketLiquidity).hook()) revert NotHook();
        if (amount == 0) revert ZeroAmount();
        GpuConfig storage cfg = _gpus[gpuId];
        if (cfg.token == address(0)) revert UnknownGpuId();
        if (!cfg.enabled) revert IssuanceDisabled();

        uint256 price = _oraclePrice(gpuId);

        base = Math.mulDiv(amount, price, compositionDivisor, Math.Rounding.Ceil);
        fee = Math.mulDiv(base, cfg.feeBps, 10_000, Math.Rounding.Ceil);
        if ( base + fee > maxGusdSpend) revert InsufficientSpend();

        _gpus[gpuId].totalIssued += amount;
        gUSD.safeTransferFrom(msg.sender, address(this), base + fee);
        if (fee > 0) gUSD.safeTransfer(revenueLedger, fee);
        gUSD.safeTransfer(marketLiquidity, base);
        IMarketLiquidity(marketLiquidity).notePrincipal(gpuId, base);
        GPUToken(cfg.token).mint(to, amount);

        emit Issued(msg.sender, gpuId, to, amount, base, fee);
    }

    /// @notice Guard-identical pre-flight of `issueCredited` for the hook's
    ///         plan phase — the same guard set and math as `quoteIssue`
    ///         (execution-identical quote doctrine).
    function quoteIssueCredited(bytes32 gpuId, uint256 amount)
        external
        view
        returns (uint256 base, uint256 fee, uint256 total)
    {
        // Same guard set and math as quoteIssue — execution-identical quote
        // doctrine (external functions are not internally callable).
        GpuConfig storage cfg = _gpus[gpuId];
        if (cfg.token == address(0)) revert UnknownGpuId();
        if (!cfg.enabled) revert IssuanceDisabled();
        uint256 price = _oraclePrice(gpuId);
        base = Math.mulDiv(amount, price, compositionDivisor, Math.Rounding.Ceil);
        fee = Math.mulDiv(base, cfg.feeBps, 10_000, Math.Rounding.Ceil);
        total = base + fee;
    }

    // --------------------------------------------------------------- views

    /// @notice Execution-identical quote: applies every guard `issue()` applies
    ///         (amount, known + enabled GPU, oracle price/freshness) so a quote
    ///         can never display a price that execution would reject.
    function quoteIssue(bytes32 gpuId, uint256 amount)
        external
        view
        returns (uint256 base, uint256 fee, uint256 totalPaid)
    {
        if (amount == 0) revert ZeroAmount();
        GpuConfig storage cfg = _gpus[gpuId];
        if (cfg.token == address(0)) revert UnknownGpuId();
        if (!cfg.enabled) revert IssuanceDisabled();
        uint256 price = _oraclePrice(gpuId);
        base = Math.mulDiv(amount, price, compositionDivisor, Math.Rounding.Ceil);
        fee = Math.mulDiv(base, cfg.feeBps, 10_000, Math.Rounding.Ceil);
        totalPaid = base + fee;
    }

    /// @notice sqrt of the current oracle price as a gUSD-wei-per-GPU-wei
    ///         ratio, scaled by 2^96 — the canonical pool's starting
    ///         sqrtPriceX96 up to currency ordering (Deploy inverts it when
    ///         gUSD is currency0). Reverts on an unpublished GPU; staleness is
    ///         deliberately NOT checked — a deploy-time starting point, not a
    ///         consumable quote.
    function oracleSqrtPriceX96(bytes32 gpuId) external view returns (uint256) {
        (uint256 price,) = oracle.getPrice(gpuId);
        if (price == 0) revert OraclePriceZero();
        // radicand = (price / compositionDivisor) * 2^192; its sqrt is
        // sqrt(ratio) * 2^96 — exactly v4's sqrtPriceX96 convention
        return FixedPointMathLib.sqrt(Math.mulDiv(price, 1 << 192, compositionDivisor));
    }

    function feeBpsOf(bytes32 gpuId) external view returns (uint16) {
        _requireKnown(gpuId);
        return _gpus[gpuId].feeBps;
    }

    /// @notice Current oracle reference price as a gUSD-wei-per-GPU-wei
    ///         sqrtPriceX96 (2^96-scaled sqrt of the price ratio), with the
    ///         full guard set `issue()` applies. Nothing is ever placed at a
    ///         stale reference.
    function referenceSqrtPriceX96(bytes32 gpuId) external view returns (uint256) {
        _oraclePrice(gpuId); // zero / future-timestamp / staleness guards
        (uint256 price,) = oracle.getPrice(gpuId);
        // radicand = (price / compositionDivisor) * 2^192; its sqrt is
        // sqrt(ratio) * 2^96 — exactly v4's sqrtPriceX96 convention
        uint256 sqrt = FixedPointMathLib.sqrt(Math.mulDiv(price, 1 << 192, compositionDivisor));
        if (sqrt > type(uint160).max) revert OraclePriceRange();
        return sqrt;
    }

    function gpuConfig(bytes32 gpuId) external view returns (GpuConfig memory) {
        return _gpus[gpuId];
    }

    function gpuIds() external view returns (bytes32[] memory) {
        return _gpuIds;
    }

    function gpuIdOfToken(address token) external view returns (bytes32) {
        return _gpuIdOfToken[token];
    }

    function tokenOf(bytes32 gpuId) external view returns (address) {
        return _gpus[gpuId].token;
    }

    function poolParamsOf(bytes32 gpuId) external view returns (PoolParams memory) {
        GpuConfig storage cfg = _gpus[gpuId];
        if (cfg.token == address(0)) revert UnknownGpuId();
        return PoolParams({fee: cfg.fee, tickSpacing: cfg.tickSpacing});
    }

    function isIssuanceEnabled(bytes32 gpuId) external view returns (bool) {
        return _gpus[gpuId].enabled;
    }

    /// @dev The oracle read + guards shared by `issue()` and `quoteIssue()`:
    ///      a quote must never show a price that execution would reject.
    function _oraclePrice(bytes32 gpuId) internal view returns (uint256 price) {
        uint256 updatedAt;
        (price, updatedAt) = oracle.getPrice(gpuId);
        if (price == 0) revert OraclePriceZero();
        if (updatedAt > block.timestamp) revert OracleFutureTimestamp();
        if (block.timestamp - updatedAt > maxOracleStaleness) revert OracleStale();
    }

    function _requireKnown(bytes32 gpuId) internal view {
        if (_gpus[gpuId].token == address(0)) revert UnknownGpuId();
    }
}
