// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibCallbackAuthenticator } from "lifi/Libraries/LibCallbackAuthenticator.sol";

/// @title PoolCallbackAuthenticated
/// @author LI.FI (https://li.fi)
/// @notice Abstract contract providing pool callback authentication functionality
/// @custom:version 1.0.0
abstract contract PoolCallbackAuthenticated {
    using LibCallbackAuthenticator for *;

    /// @dev Ensures callback is from expected pool and cleans up after callback
    modifier onlyExpectedPool() {
        LibCallbackAuthenticator.verifyCallbackSender();
        _;
        LibCallbackAuthenticator.disarm();
    }
}
