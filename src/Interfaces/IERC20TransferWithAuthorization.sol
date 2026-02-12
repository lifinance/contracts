// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IERC20TransferWithAuthorization
/// @author LI.FI (https://li.fi)
/// @notice EIP-3009 token interface. Permit2Proxy uses only receiveWithAuthorization; transferWithAuthorization is not supported due to front-run risk.
/// @custom:version 1.1.0
interface IERC20TransferWithAuthorization {
    /// @dev transferWithAuthorization is not used by LI.FI since anyone may call this on the token,
    //       so it can be front-run. We only call receiveWithAuthorization.

    /// @notice Receives tokens using a signed authorization (EIP-3009). Only the payee (to) may call; front-run safe.
    /// @param from Payer's address (authorizer)
    /// @param to Payee's address (must equal msg.sender on the token)
    /// @param value Amount to transfer
    /// @param validAfter Authorization valid only after this timestamp
    /// @param validBefore Authorization valid only before this timestamp
    /// @param nonce Unique nonce to prevent replay
    /// @param v Recovery ID of the signature
    /// @param r ECDSA signature output
    /// @param s ECDSA signature output
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @notice Receives tokens using a signed authorization with opaque signature (ERC-7598 / ERC-1271).
    /// @param from Payer's address (authorizer)
    /// @param to Payee's address (must equal msg.sender on the token)
    /// @param value Amount to transfer
    /// @param validAfter Authorization valid only after this timestamp
    /// @param validBefore Authorization valid only before this timestamp
    /// @param nonce Unique nonce to prevent replay
    /// @param signature Opaque signature bytes (e.g. ECDSA packed or wallet-encoded for contract signers)
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
}
