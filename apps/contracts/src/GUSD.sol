// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title GUSD — the protocol's USDC-backed unit of account.
/// @notice 1 gUSD is backed by exactly 1 USDC held in this contract. gUSD is
///         created only via {mintUSDC} and destroyed only via {redeemUSDC};
///         the structural invariant `USDC.balanceOf(this) == totalSupply()`
///         therefore holds exactly at every state boundary.
/// @dev The issuance fee (and any future fee) is charged in gUSD and minted to
///      `revenueSink` in the same breath as the user's mint, so the reserve
///      equality never breaks: every gUSD in existence is backed 1:1.
contract GUSD is ERC20, ERC20Permit, Pausable, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Hard cap on mint/redeem fees (5%).
    uint16 public constant MAX_FEE_BPS = 500;

    /// @notice The USDC backing gUSD.
    IERC20 public immutable underlying;

    /// @notice Where mint/redeem fees are sent (RevenueLedger).
    address public revenueSink;

    uint16 public mintFeeBps;
    uint16 public redeemFeeBps;

    error ZeroAmount();
    error ZeroNetAmount();
    error FeeTooLarge();
    error InvalidSink();

    event Minted(address indexed to, uint256 usdcIn, uint256 gusdOut, uint256 fee);
    event Redeemed(address indexed from, uint256 gusdIn, uint256 usdcOut, uint256 fee);
    event FeesUpdated(uint16 mintFeeBps, uint16 redeemFeeBps);
    event RevenueSinkUpdated(address indexed sink);

    constructor(IERC20 underlying_, address initialOwner)
        ERC20("Gigawatt Dollar", "gUSD")
        ERC20Permit("Gigawatt Dollar")
        Ownable(initialOwner)
    {
        underlying = underlying_;
    }

    // ---------------------------------------------------------------- owner

    function setFees(uint16 mintFeeBps_, uint16 redeemFeeBps_) external onlyOwner {
        if (mintFeeBps_ > MAX_FEE_BPS || redeemFeeBps_ > MAX_FEE_BPS) revert FeeTooLarge();
        if ((mintFeeBps_ > 0 || redeemFeeBps_ > 0) && revenueSink == address(0)) revert InvalidSink();
        mintFeeBps = mintFeeBps_;
        redeemFeeBps = redeemFeeBps_;
        emit FeesUpdated(mintFeeBps_, redeemFeeBps_);
    }

    function setRevenueSink(address sink) external onlyOwner {
        if (sink == address(0)) revert InvalidSink();
        revenueSink = sink;
        emit RevenueSinkUpdated(sink);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------- monetary

    /// @notice Exchanges `usdcAmount` USDC for gUSD, net of the mint fee.
    function mintUSDC(uint256 usdcAmount, address to) external whenNotPaused nonReentrant returns (uint256 gusdOut) {
        if (usdcAmount == 0) revert ZeroAmount();
        uint256 fee = Math.mulDiv(usdcAmount, mintFeeBps, 10_000, Math.Rounding.Ceil);
        gusdOut = usdcAmount - fee;
        if (gusdOut == 0) revert ZeroNetAmount();

        underlying.safeTransferFrom(msg.sender, address(this), usdcAmount);
        _mint(to, gusdOut);
        if (fee > 0) _mint(revenueSink, fee);

        emit Minted(to, usdcAmount, gusdOut, fee);
    }

    /// @notice Exchanges `gusdAmount` gUSD for USDC, net of the redeem fee.
    /// @dev Burns first, then all other effects, then the external transfer
    ///      (checks-effects-interactions).
    function redeemUSDC(uint256 gusdAmount, address to) external whenNotPaused nonReentrant returns (uint256 usdcOut) {
        if (gusdAmount == 0) revert ZeroAmount();
        uint256 fee = Math.mulDiv(gusdAmount, redeemFeeBps, 10_000, Math.Rounding.Ceil);
        usdcOut = gusdAmount - fee;
        if (usdcOut == 0) revert ZeroNetAmount();

        _burn(msg.sender, gusdAmount);
        if (fee > 0) _mint(revenueSink, fee);
        underlying.safeTransfer(to, usdcOut);

        emit Redeemed(msg.sender, gusdAmount, usdcOut, fee);
    }

    /// @notice gUSD has 6 decimals to mirror USDC 1:1.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice USDC held as reserve; structurally equal to totalSupply().
    function reserveBalance() external view returns (uint256) {
        return underlying.balanceOf(address(this));
    }

    function previewMintUSDC(uint256 usdcAmount) external view returns (uint256 gusdOut) {
        if (usdcAmount == 0) revert ZeroAmount();
        gusdOut = usdcAmount - Math.mulDiv(usdcAmount, mintFeeBps, 10_000, Math.Rounding.Ceil);
    }

    function previewRedeemUSDC(uint256 gusdAmount) external view returns (uint256 usdcOut) {
        if (gusdAmount == 0) revert ZeroAmount();
        usdcOut = gusdAmount - Math.mulDiv(gusdAmount, redeemFeeBps, 10_000, Math.Rounding.Ceil);
    }
}
