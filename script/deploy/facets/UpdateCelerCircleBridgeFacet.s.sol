// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { CelerCircleBridgeFacet } from "lifi/Facets/CelerCircleBridgeFacet.sol";

contract DeployScript is UpdateScriptBase {
    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("CelerCircleBridgeFacet");
    }

    function getExcludes() internal pure override returns (bytes4[] memory) {
        bytes4[] memory excludes = new bytes4[](1);
        excludes[0] = CelerCircleBridgeFacet.initCelerCircleBridge.selector;

        return excludes;
    }

    function getCallData() internal pure override returns (bytes memory) {
        return
            abi.encodeWithSelector(
                CelerCircleBridgeFacet.initCelerCircleBridge.selector
            );
    }
}
