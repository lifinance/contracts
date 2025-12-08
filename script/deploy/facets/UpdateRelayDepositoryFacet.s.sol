// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";

contract UpdateScript is UpdateScriptBase {
    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("RelayDepositoryFacet");
    }
}
