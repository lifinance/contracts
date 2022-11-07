// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.9;

import "./proxies/CommonOwnerProxy.sol";
import "./proxies/BridgeOwnerProxy.sol";
import "./proxies/MessageOwnerProxy.sol";
import "./proxies/SgnOwnerProxy.sol";
import "./proxies/UpgradeableOwnerProxy.sol";

contract GovernedOwnerProxy is
    CommonOwnerProxy,
    BridgeOwnerProxy,
    MessageOwnerProxy,
    SgnOwnerProxy,
    UpgradeableOwnerProxy
{
    constructor(address _initializer) OwnerProxyBase(_initializer) {}
}
