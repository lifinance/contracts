// SPDX-License-Identifier: GPL-3.0-only

pragma solidity >=0.8.0;

import "../SimpleGovernance.sol";

abstract contract OwnerProxyBase {
    SimpleGovernance public gov;
    address private initializer;

    constructor(address _initializer) {
        initializer = _initializer;
    }

    function initGov(SimpleGovernance _gov) public {
        require(msg.sender == initializer, "only initializer can init");
        require(address(gov) == address(0), "gov addr already set");
        gov = _gov;
    }
}
