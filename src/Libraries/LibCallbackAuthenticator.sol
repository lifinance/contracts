// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title Callback Manager Library
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for managing callback validation in diamond-safe storage
/// @custom:version 1.0.0
library LibCallbackAuthenticator {
    /// Types ///
    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.lda.callbackAuthenticator");

    /// Storage ///
    struct CallbackStorage {
        address expected;
    }

    /// Errors ///
    error UnexpectedCallbackSender(address actual, address expected);

    /// @dev Fetch local storage
    function callbackStorage()
        internal
        pure
        returns (CallbackStorage storage cbStor)
    {
        bytes32 position = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            cbStor.slot := position
        }
    }

    /// @notice Arm the guard with expected pool
    /// @param expectedCallbackSender The address expected to call the callback
    function arm(address expectedCallbackSender) internal {
        callbackStorage().expected = expectedCallbackSender;
    }

    /// @notice Disarm the guard (called inside the callback)
    function disarm() internal {
        callbackStorage().expected = address(0);
    }

    /// @notice Check that callback comes from expected address
    function verifyCallbackSender() internal view {
        address expected = callbackStorage().expected;
        if (msg.sender != expected) {
            revert UnexpectedCallbackSender(msg.sender, expected);
        }
    }
}
