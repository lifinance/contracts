// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateLDAScriptBase } from "./utils/UpdateLDAScriptBase.sol";

contract DeployScript is UpdateLDAScriptBase {
    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("UniV2StyleFacet");
    }
}
