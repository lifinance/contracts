// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibCallbackAuthenticator } from "lifi/Libraries/LibCallbackAuthenticator.sol";

abstract contract PoolCallbackAuthenticated {
    using LibCallbackAuthenticator for *;

    /// @dev Ensures callback is from expected pool and cleans up after callback
    modifier onlyExpectedPool() {
        LibCallbackAuthenticator.verifyCallbackSender();
        _;
        LibCallbackAuthenticator.disarm();
    }
}
