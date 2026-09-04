// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title GpuId
/// @notice Canonical GPU identifier helpers.
/// @dev A GPU ID is a bytes32 holding a left-aligned, zero-padded ASCII SKU string
///      (e.g. `bytes32(bytes("H100_SXM_80GB"))`). This is bijective with the string IDs
///      used by the offchain oracle stack (`packages/gpu-catalog`), so no registry is
///      needed to recover the SKU name. All bytes after the first zero byte must be zero.
library GpuId {
    /// @notice GPU ID is empty.
    error EmptyGpuId();
    /// @notice GPU ID exceeds 32 bytes.
    error GpuIdTooLong();
    /// @notice GPU ID contains a non-printable-ASCII byte (allowed range 0x21..0x7E).
    error InvalidGpuIdChar();
    /// @notice GPU ID has data after an embedded zero byte (not left-aligned padding).
    error GpuIdNotLeftAligned();

    /// @notice Converts a SKU string to its canonical bytes32 form, validating it.
    function fromString(string memory sku) internal pure returns (bytes32) {
        bytes memory raw = bytes(sku);
        uint256 len = raw.length;
        if (len == 0) revert EmptyGpuId();
        if (len > 32) revert GpuIdTooLong();
        // Left-align and zero-pad into bytes32.
        bytes32 id;
        for (uint256 i = 0; i < len; i++) {
            uint8 b = uint8(raw[i]);
            if (b < 0x21 || b > 0x7E) revert InvalidGpuIdChar();
            id |= bytes32(uint256(b) << (8 * (31 - i)));
        }
        return id;
    }

    /// @notice Reverts unless `gpuId` is a valid canonical ID: 1-32 printable ASCII
    ///         bytes, left-aligned with zero padding.
    function validate(bytes32 gpuId) internal pure {
        if (gpuId == bytes32(0)) revert EmptyGpuId();
        bool terminated;
        for (uint256 i = 0; i < 32; i++) {
            uint8 b = uint8(gpuId[i]);
            if (terminated) {
                if (b != 0) revert GpuIdNotLeftAligned();
            } else if (b == 0) {
                terminated = true;
            } else if (b < 0x21 || b > 0x7E) {
                revert InvalidGpuIdChar();
            }
        }
        // A full 32-byte printable-ASCII ID is valid without padding; nothing to check.
    }

    /// @notice Whether `gpuId` is valid (1-32 printable ASCII, left-aligned).
    function isValid(bytes32 gpuId) internal pure returns (bool) {
        if (gpuId == bytes32(0)) return false;
        bool terminated;
        for (uint256 i = 0; i < 32; i++) {
            uint8 b = uint8(gpuId[i]);
            if (terminated) {
                if (b != 0) return false;
            } else if (b == 0) {
                terminated = true;
            } else if (b < 0x21 || b > 0x7E) {
                return false;
            }
        }
        return true;
    }

    /// @notice Recovers the SKU string from its canonical bytes32 form.
    function toString(bytes32 gpuId) internal pure returns (string memory) {
        validate(gpuId);
        uint256 len = 32;
        while (len > 0 && uint8(gpuId[len - 1]) == 0) {
            len--;
        }
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            out[i] = gpuId[i];
        }
        return string(out);
    }
}
