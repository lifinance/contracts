// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IERC20Permit7597
/// @author LI.FI (https://li.fi)
/// @notice ERC-7597 permit: EIP-2612–style permit with opaque bytes signature for EOA or ERC-1271 contract signers.
/// @custom:version 1.0.0
interface IERC20Permit7597 {
    /// @notice Sets allowance for spender via signature; format of signature is implementation-defined (e.g. wallet-specific).
    /// @param owner Token owner (and signer or contract implementing ERC-1271)
    /// @param spender Approved spender
    /// @param value Allowance amount
    /// @param deadline Permit deadline
    /// @param signature Opaque signature bytes (e.g. raw (r,s,v) or wallet-encoded)
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        bytes calldata signature
    ) external;
}
