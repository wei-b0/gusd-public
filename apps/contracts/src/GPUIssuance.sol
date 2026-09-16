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
import {IGpuOracle} from "./oracle/IGpuOracle.sol";
import {ReportCodec} from "./oracle/ReportCodec.sol";
import {IGPUIssuance} from "./interfaces/IGPUIssuance.sol";
import {IMarketLiquidity} from "./interfaces/IMarketLiquidity.sol";

/// @title GPUIssuance — permissionless primary market for GPU-hour claims.
/// @notice Users pay gUSD (report price + issuance fee) and mint GPU tokens.
///         The base payment is forwarded to GPUMarketLiquidity, where it
///         progressively capitalizes the GPU's canonical market as bid-side
///         liquidity around the report reference. There is no NAV redemption
///         and no withdrawal path anywhere: principal exits only as market
///         trades. Issuance never touches the pool — placement is a separate
///         permissionless step, so a v4 problem can never fail a primary buy.
/// @dev    Pull-oracle pricing: every entrypoint takes the oracle report
///         (`updateData = abi.encode(Report, signature)`, see IGpuOracle) and
///         prices at the report the caller submitted — never a cached price.
///         `issue`/`issueCredited` CONSUME the report (epoch binding); the
///         quote views VERIFY it, so a quote can only exist for a report
///         execution would accept (execution-identical quote doctrine).
///         Issuance composition (all coordination-fixed):
///         base(6dec gUSD) = amount(18dec) * price(4dec) / 10^16, Ceil.
///         Worked example: 100 H100 @ 2.5000 -> 100e18 * 25_000 / 1e16
///         = 250_000_000 = 250.000000 gUSD.
///         The 4-decimal price convention (PRICE_SCALE = 10_000) is
///         coordination-fixed; the composition divisor is derived from it,
///         never re-declared as a literal. Report prices are submitted
///         already scaled, so there is no oracle-scale constructor check.
contract GPUIssuance is IGPUIssuance, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_ISSUANCE_FEE_BPS = 1_000; // 10%
    uint256 public constant PRICE_SCALE = 10_000; // 4-decimal fixed point (coordination-fixed)

    // 10^(gpusDecimals 18 + priceDecimals 4 - gusdDecimals 6) == 1e16,
    // derived from PRICE_SCALE — never re-declared as a literal.
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
    IGpuOracle public immutable oracle;
    address public immutable revenueLedger;
    address public immutable marketLiquidity;

    mapping(bytes32 => GpuConfig) internal _gpus;
    mapping(address => bytes32) internal _gpuIdOfToken;
    bytes32[] internal _gpuIds;

    error UnknownGpuId();
    error GpuAlreadyExists();
    error IssuanceDisabled();
    error OraclePriceRange();
    error ZeroAmount();
    error ZeroAddress();
    error FeeTooLarge();
    error InsufficientSpend();
    error NotHook();

    event GpuCreated(bytes32 indexed gpuId, address token, uint16 feeBps, uint24 poolFee, int24 tickSpacing);
    event Issued(
        address indexed caller, bytes32 indexed gpuId, address indexed to, uint256 amount, uint256 base, uint256 fee
    );
    event IssuanceEnabledSet(bytes32 indexed gpuId, bool enabled);
    event IssuanceFeeSet(bytes32 indexed gpuId, uint16 feeBps);

    constructor(IERC20 gUSD_, IGpuOracle oracle_, address revenueLedger_, address marketLiquidity_, address initialOwner)
        Ownable(initialOwner)
    {
        if (marketLiquidity_ == address(0)) revert ZeroAddress();
        gUSD = gUSD_;
        oracle = oracle_;
        revenueLedger = revenueLedger_;
        marketLiquidity = marketLiquidity_;
        // 10^(gpusDecimals 18 + priceDecimals 4 - gusdDecimals 6), derived from
        // the coordination-fixed PRICE_SCALE — never re-declared as a literal.
        compositionDivisor = Math.mulDiv(10 ** 18, PRICE_SCALE, 10 ** 6);
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

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------ issuance

    /// @notice Buys `amount` GPU tokens at the submitted report price +
    ///         issuance fee. The report is CONSUMED (verified against the
    ///         current epoch, epoch-binding applied) — direct issuance without
    ///         a current authenticated report reverts. The base payment is
    ///         forwarded to `marketLiquidity` (the POL), where it capitalizes
    ///         the GPU's canonical market as bid-side liquidity around the
    ///         report reference; the fee is protocol revenue. No v4
    ///         interaction: placement is a separate permissionless step, so a
    ///         v4 problem can never fail a primary buy.
    /// @param updateData The signed oracle report wire format
    ///        `abi.encode(Report, signature)` pricing THIS issuance.
    /// @return base gUSD paid as market capital (excludes fee).
    /// @return fee gUSD paid as issuance fee to the revenue ledger.
    function issue(bytes32 gpuId, uint256 amount, address to, bytes calldata updateData)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 base, uint256 fee)
    {
        if (amount == 0) revert ZeroAmount();
        GpuConfig storage cfg = _gpus[gpuId];
        if (cfg.token == address(0)) revert UnknownGpuId();
        if (!cfg.enabled) revert IssuanceDisabled();

        (IGpuOracle.Report calldata report, bytes calldata signature) = ReportCodec.decode(updateData);
        uint256 price = oracle.consume(gpuId, report, signature);

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
        // it as a bid band around the report reference
        gUSD.safeTransfer(marketLiquidity, base);
        IMarketLiquidity(marketLiquidity).notePrincipal(gpuId, base);
        GPUToken(cfg.token).mint(to, amount);

        emit Issued(msg.sender, gpuId, to, amount, base, fee);
    }

    /// @notice In-swap issuance backstop for GPUHook: pricing and guards are
    ///         identical to `issue()`, paid by transferFrom from the caller
    ///         (the hook, inside a PoolManager lock), minting to `to`.
    ///         `updateData` must be the SAME report the hook verified in
    ///         beforeSwap — the oracle's transient dedupe skips the duplicate
    ///         ecrecover. Reverts when `base + fee > maxGusdSpend` — the hook
    ///         absorbs exactly what it plans to spend, so any divergence
    ///         between the plan-time quote and this execution fails closed
    ///         instead of bleeding capital. Zero v4 interaction.
    function issueCredited(bytes32 gpuId, uint256 amount, address to, uint256 maxGusdSpend, bytes calldata updateData)
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

        (IGpuOracle.Report calldata report, bytes calldata signature) = ReportCodec.decode(updateData);
        uint256 price = oracle.consume(gpuId, report, signature);

        base = Math.mulDiv(amount, price, compositionDivisor, Math.Rounding.Ceil);
        fee = Math.mulDiv(base, cfg.feeBps, 10_000, Math.Rounding.Ceil);
        if (base + fee > maxGusdSpend) revert InsufficientSpend();

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
    ///         (execution-identical quote doctrine). VERIFIES the exact report
    ///         execution will consume: a quote can only exist for a report
    ///         execution would accept.
    function quoteIssueCredited(bytes32 gpuId, uint256 amount, bytes calldata updateData)
        external
        view
        returns (uint256 base, uint256 fee, uint256 total)
    {
        // Same guard set and math as quoteIssue — execution-identical quote
        // doctrine (external functions are not internally callable).
        GpuConfig storage cfg = _gpus[gpuId];
        if (cfg.token == address(0)) revert UnknownGpuId();
        if (!cfg.enabled) revert IssuanceDisabled();
        (IGpuOracle.Report calldata report, bytes calldata signature) = ReportCodec.decode(updateData);
        uint256 price = oracle.verify(gpuId, report, signature);
        base = Math.mulDiv(amount, price, compositionDivisor, Math.Rounding.Ceil);
        fee = Math.mulDiv(base, cfg.feeBps, 10_000, Math.Rounding.Ceil);
        total = base + fee;
    }

    // --------------------------------------------------------------- views

    /// @notice Execution-identical quote: applies every guard `issue()` applies
    ///         (amount, known + enabled GPU, full report acceptance set) so a
    ///         quote can never display a price that execution would reject.
    ///         VERIFIES the exact report — never a cached price.
    function quoteIssue(bytes32 gpuId, uint256 amount, bytes calldata updateData)
        external
        view
        returns (uint256 base, uint256 fee, uint256 totalPaid)
    {
        if (amount == 0) revert ZeroAmount();
        GpuConfig storage cfg = _gpus[gpuId];
        if (cfg.token == address(0)) revert UnknownGpuId();
        if (!cfg.enabled) revert IssuanceDisabled();
        (IGpuOracle.Report calldata report, bytes calldata signature) = ReportCodec.decode(updateData);
        uint256 price = oracle.verify(gpuId, report, signature);
        base = Math.mulDiv(amount, price, compositionDivisor, Math.Rounding.Ceil);
        fee = Math.mulDiv(base, cfg.feeBps, 10_000, Math.Rounding.Ceil);
        totalPaid = base + fee;
    }

    /// @notice sqrt of a report price as a gUSD-wei-per-GPU-wei ratio, scaled
    ///         by 2^96 — the canonical pool's starting sqrtPriceX96 up to
    ///         currency ordering (deploy inverts it when gUSD is currency0).
    ///         Pure math on a scaled price; the full acceptance set is applied
    ///         by `reportSqrtPriceX96` when the report itself is the source.
    function priceSqrtPriceX96(uint256 price) public pure returns (uint256) {
        // radicand = (price / compositionDivisor) * 2^192; its sqrt is
        // sqrt(ratio) * 2^96 — exactly v4's sqrtPriceX96 convention
        uint256 sqrt = FixedPointMathLib.sqrt(Math.mulDiv(price, 1 << 192, compositionDivisor));
        if (sqrt > type(uint160).max) revert OraclePriceRange();
        return sqrt;
    }

    /// @notice Reference sqrt for a verified report: applies the FULL
    ///         acceptance set (current epoch, signature, binding bounds) —
    ///         nothing is ever placed at an unverified reference. Tooling
    ///         display use; trade execution never calls this.
    function reportSqrtPriceX96(bytes32 gpuId, IGpuOracle.Report calldata report, bytes calldata signature)
        external
        view
        returns (uint256)
    {
        uint256 price = oracle.verify(gpuId, report, signature);
        return priceSqrtPriceX96(price);
    }

    function feeBpsOf(bytes32 gpuId) external view returns (uint16) {
        _requireKnown(gpuId);
        return _gpus[gpuId].feeBps;
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

    function _requireKnown(bytes32 gpuId) internal view {
        if (_gpus[gpuId].token == address(0)) revert UnknownGpuId();
    }
}
