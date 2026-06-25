// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBase } from "./TestBase.sol";

/// @dev Marker base for tests that must not fork mainnet. Call initTestBaseLocal() in setUp.
abstract contract TestBaseLocal is TestBase {}
