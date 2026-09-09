// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {GpuId} from "./libraries/GpuId.sol";
import {IGPUIssuance} from "./interfaces/IGPUIssuance.sol";
import {IMarketLiquidity} from "./interfaces/IMarketLiquidity.sol";

/// @title GPUMarketLiquidity — protocol-owned inventory vault.
/// @notice Holds the POL's two-sided inventory: gUSD bid capacity (capitalized
///         by primary principal) and GPU ask inventory (acquired by genuine
///         bid fills). Custody is hook-only pull/push: gUSD and GPU leave only
///         to the PoolManager (settled by the hook inside a lock), gUSD enters
///         only from issuance principal or hook-settled trade proceeds. There
///         is no withdrawal path to any EOA and no redemption of principal:
///         principal exits only as market trades.
/// @dev    The hook settles all fills inside the PoolManager lock; the vault
///         is pure inventory + provenance. Donations strand outside mapped
///         inventory (invariant tests enforce balance >= mapped sums).
contract GPUMarketLiquidity is IMarketLiquidity, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable gUSD;
    address public immutable poolManager;
    address public hook;
    address public issuance;

    error OnlyHook();
    error OnlyIssuance();
    error ZeroAddress();
    error ZeroAmount();
    error AlreadySet();
    error UnknownGpuId();
    error InsufficientBidInventory();
    error InsufficientAskInventory();
    error CustodyBacked();

    event PrincipalNoted(bytes32 indexed gpuId, uint256 amount);
    event GpuNoted(bytes32 indexed gpuId, uint256 amount);
    event BidCredited(bytes32 indexed gpuId, uint256 amount);
    event InventoryPulled(bytes32 indexed gpuId, address token, uint256 amount, bool isGusd);

    uint256 internal _totalBidGusd;
    mapping(bytes32 => uint256) internal _bidInventoryGusd;
    mapping(bytes32 => uint256) internal _askInventoryGpu;
    mapping(bytes32 => uint256) internal _principalContributed;

    constructor(IERC20 gUSD_, address poolManager_, address initialOwner) Ownable(initialOwner) {
        if (address(gUSD_) == address(0) || poolManager_ == address(0)) revert ZeroAddress();
        gUSD = gUSD_;
        poolManager = poolManager_;
    }

    /// @notice One-shot wiring. Deploy order: vault -> issuance -> hook ->
    ///         vault.setRefs, so the issuance/vault/hook dependency cycle
    ///         (issuance.marketLiquidity immutable, hook.immutables,
    ///         vault.hook gate) is broken here.
    function setRefs(address issuance_, address hook_) external onlyOwner {
        if (issuance_ == address(0) || hook_ == address(0)) revert ZeroAddress();
        if (issuance != address(0) || hook != address(0)) revert AlreadySet();
        issuance = issuance_;
        hook = hook_;
    }

    // ------------------------------------------------------ hook operations

    modifier onlyHook() {
        if (msg.sender != hook) revert OnlyHook();
        _;
    }

    modifier onlyIssuance() {
        if (msg.sender != issuance) revert OnlyIssuance();
        _;
    }

    /// @notice Issuance has transferred `amount` gUSD to the vault; book it
    ///         as bid capacity and cumulative principal (provenance).
    function notePrincipal(bytes32 gpuId, uint256 amount) external onlyIssuance nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _bidInventoryGusd[gpuId] += amount;
        _principalContributed[gpuId] += amount;
        _totalBidGusd += amount;
        if (_totalBidGusd > gUSD.balanceOf(address(this))) revert CustodyBacked();
        emit PrincipalNoted(gpuId, amount);
    }

    /// @notice The hook has taken `amount` GPU from the PM directly to the
    ///         vault (take to vault). Book ask-side inventory.
    function noteGpu(bytes32 gpuId, uint256 amount) external onlyHook nonReentrant {
        if (amount == 0) revert ZeroAmount();
        IERC20 token = IERC20(IGPUIssuance(issuance).tokenOf(gpuId));
        _askInventoryGpu[gpuId] += amount;
        if (_askInventoryGpu[gpuId] > token.balanceOf(address(this))) revert CustodyBacked();
        emit GpuNoted(gpuId, amount);
    }

    /// @notice Ask-side fill: vault GPU -> PM; the hook settles it inside the
    ///         lock to cover its GPU delivery debt.
    function pullGpuToManager(bytes32 gpuId, uint256 amount) external onlyHook nonReentrant {
        if (amount == 0) revert ZeroAmount();
        IERC20 token = IERC20(IGPUIssuance(issuance).tokenOf(gpuId));
        if (token == IERC20(address(0))) revert UnknownGpuId();
        if (amount > _askInventoryGpu[gpuId]) revert InsufficientAskInventory();
        _askInventoryGpu[gpuId] -= amount;
        token.safeTransfer(poolManager, amount);
        emit InventoryPulled(gpuId, address(token), amount, false);
    }

    /// @notice Bid-side fill: vault gUSD -> PM; the hook settles it inside the
    ///         lock to fund the seller's proceeds.
    function pullGusdToManager(bytes32 gpuId, uint256 amount) external onlyHook nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > _bidInventoryGusd[gpuId]) revert InsufficientBidInventory();
        _bidInventoryGusd[gpuId] -= amount;
        _totalBidGusd -= amount;
        gUSD.safeTransfer(poolManager, amount);
        emit InventoryPulled(gpuId, address(gUSD), amount, true);
    }

    /// @notice POL buy fill settlement: the hook transfers its absorbed gUSD
    ///         proceeds to the vault; booked as bid capacity. Custody check:
    ///         total mapped bid inventory must stay backed 1:1 by balance.
    function creditBidFromTrade(bytes32 gpuId, uint256 amount) external onlyHook nonReentrant {
        if (amount == 0) revert ZeroAmount();
        gUSD.safeTransferFrom(msg.sender, address(this), amount);
        _bidInventoryGusd[gpuId] += amount;
        _totalBidGusd += amount;
        if (_totalBidGusd > gUSD.balanceOf(address(this))) revert CustodyBacked();
        emit BidCredited(gpuId, amount);
    }

    // --------------------------------------------------------------- views

    function bidInventoryGusd(bytes32 gpuId) external view returns (uint256) {
        return _bidInventoryGusd[gpuId];
    }

    function askInventoryGpu(bytes32 gpuId) external view returns (uint256) {
        return _askInventoryGpu[gpuId];
    }

    function principalContributed(bytes32 gpuId) external view returns (uint256) {
        return _principalContributed[gpuId];
    }

    function totalBidGusd() external view returns (uint256) {
        return _totalBidGusd;
    }
}
