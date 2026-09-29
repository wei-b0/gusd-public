// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ISgUSD} from "./interfaces/ISgUSD.sol";

/// @title sgUSD — staked gUSD, the protocol's yield-bearing receipt.
/// @notice An ERC-4626 vault over gUSD. Revenue reaches stakers by a plain
///         gUSD transfer into this vault from {RevenueLedger} — no deposit
///         call, no shares minted to the protocol — so `totalAssets()`
///         (balance-based) rises and the share price appreciates.
/// @dev One-way owner `seed()` gate: no shares can exist before the owner
///      seeds the vault with real gUSD, which structurally blocks the
///      first-depositor share-inflation attack at genesis.
///
///      PERP UNDERWRITING (PROTOCOL.md, perp section): the vault is also the
///      counterparty capital for {GpuPerpEngine} — trader payouts are
///      withdrawn by the engine (`perpWithdraw`) and trader losses are bare
///      gUSD transfers INTO the vault (raising the share price, the
///      RevenueLedger pattern). The engine pushes `perpReserved` — settled
///      claimable balances plus the open positions' last-touched positive
///      PnL — and ordinary redemptions cannot dip into that reserve: perp
///      claims take precedence over redeemer withdrawals. Everything else
///      about this vault's semantics is unchanged.
contract sgUSD is ERC4626, Ownable2Step, ISgUSD {
    using Math for uint256;
    using SafeERC20 for IERC20;

    bool private _seeded;

    address public perpEngine;
    uint256 public perpReserved;
    uint256 public engineMaxWithdrawPerBlock;

    error NotSeeded();
    error ZeroShares();
    error AlreadySeeded();
    error DecimalsMismatch();
    error ZeroEngine();

    event Seeded(uint256 assets);

    constructor(IERC20 gusd, address initialOwner)
        ERC4626(gusd)
        ERC20("Staked Gigawatt Dollar", "sgUSD")
        Ownable(initialOwner)
    {
        if (IERC20Metadata(address(gusd)).decimals() != 6) {
            revert DecimalsMismatch();
        }
    }

    /// @notice One-way genesis gate: owner deposits `assets` gUSD at 1:1.
    function seed(uint256 assets) external onlyOwner {
        if (_seeded) revert AlreadySeeded();
        if (assets == 0) revert ZeroShares();
        _seeded = true;
        _deposit(msg.sender, address(this), assets, assets);
        emit Seeded(assets);
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        if (!_seeded) revert NotSeeded();
        super._deposit(caller, receiver, assets, shares);
    }

    function seeded() external view returns (bool) {
        return _seeded;
    }

    /// @notice 6-dec shares to match the 6-dec asset (1:1 genesis).
    function _decimalsOffset() internal pure override returns (uint8) {
        return 0;
    }

    // ---------------------------------------------------------- perp surface

    function setPerpEngine(address engine) external onlyOwner {
        if (engine == address(0)) revert ZeroEngine();
        perpEngine = engine;
        emit ISgUSD.PerpEngineSet(engine);
    }

    function setEngineMaxWithdrawPerBlock(uint256 cap) external onlyOwner {
        engineMaxWithdrawPerBlock = cap;
        emit ISgUSD.EngineWithdrawalCapSet(cap);
    }

    function setPerpReserved(uint256 reserved) external {
        if (msg.sender != perpEngine) revert ISgUSD.NotPerpEngine();
        perpReserved = reserved;
        emit ISgUSD.PerpReservedUpdated(reserved);
    }

    /// @notice Pays a settled perp claim out of vault liquidity — never more
    ///         than the vault actually holds and never more than the per-block
    ///         cap (both clamp: partial payment is the designed crunch
    ///         behavior — a claim must never revert for liquidity or rate
    ///         limiting). Exempt from the redemption reserve: this IS the
    ///         reserved party paying.
    function perpWithdraw(address to, uint256 amount) external returns (uint256 paid) {
        if (msg.sender != perpEngine) revert ISgUSD.NotPerpEngine();
        uint256 balance = IERC20(asset()).balanceOf(address(this));
        uint256 used = _engineWithdrawnThisBlock();
        uint256 cap = engineMaxWithdrawPerBlock;
        uint256 room = cap > used ? cap - used : 0;
        paid = amount > balance ? balance : amount;
        if (paid > room) paid = room;
        _setEngineWithdrawnThisBlock(used + paid);
        IERC20(asset()).safeTransfer(to, paid);
        emit ISgUSD.EngineWithdrawal(to, amount, paid);
    }

    /// @notice gUSD the ordinary redemption path may not touch.
    function availableForRedemption() public view returns (uint256) {
        uint256 balance = IERC20(asset()).balanceOf(address(this));
        return balance > perpReserved ? balance - perpReserved : 0;
    }

    // ---------------------------------------------------- ERC4626 overrides

    /// @dev Perp claims take precedence over redeemer withdrawals.
    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        uint256 available = availableForRedemption();
        if (assets > available) revert ISgUSD.PerpReservationShortfall(available, assets);
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    /// @dev Honest previews: a withdrawal that execution would revert is never
    ///      displayed as available.
    function maxWithdraw(address owner) public view override returns (uint256) {
        return Math.min(_convertToAssets(balanceOf(owner), Math.Rounding.Floor), availableForRedemption());
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        uint256 assets = maxWithdraw(owner);
        if (assets == 0) return 0;
        return _convertToShares(assets, Math.Rounding.Floor);
    }

    function previewWithdraw(uint256 assets) public view override returns (uint256) {
        if (assets > availableForRedemption()) {
            revert ISgUSD.PerpReservationShortfall(availableForRedemption(), assets);
        }
        return super.previewWithdraw(assets);
    }

    function previewRedeem(uint256 shares) public view override returns (uint256) {
        uint256 assets = super.previewRedeem(shares);
        if (assets > availableForRedemption()) {
            revert ISgUSD.PerpReservationShortfall(availableForRedemption(), assets);
        }
        return assets;
    }

    // ------------------------------------------------- per-block cap (persistent)

    /// @dev Engine-withdrawal usage for the current block, packed into ONE
    ///      storage slot: `(blockNumber << 192) | usedThisBlock`. A transient
    ///      (TSTORE) counter cannot work here — transient storage is cleared
    ///      between transactions, so several txs in one block would each see
    ///      a fresh cap. `used` is bounded by the vault balance of a 6-dec
    ///      token and can never approach uint192; block numbers fit in the
    ///      remaining 64 bits.
    uint256 private _engineWithdrawn;

    function _engineWithdrawnThisBlock() private view returns (uint256 used) {
        uint256 packed_ = _engineWithdrawn;
        if (packed_ >> 192 == block.number) {
            used = uint192(packed_);
        }
    }

    function _setEngineWithdrawnThisBlock(uint256 used) private {
        _engineWithdrawn = (block.number << 192) | uint192(used);
    }
}