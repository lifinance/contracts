// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { CBridgeFacetPacked } from "lifi/Facets/CBridgeFacetPacked.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("CBridgeFacetPacked");
    }

    function getExcludes() internal view override returns (bytes4[] memory) {
        CBridgeFacetPacked cbridge;
        bytes4[] memory excludes = new bytes4[](7);
        excludes[0] = cbridge.cancelOwnershipTransfer.selector;
        excludes[1] = cbridge.transferOwnership.selector;
        excludes[2] = cbridge.confirmOwnershipTransfer.selector;
        excludes[3] = cbridge.owner.selector;
        excludes[4] = cbridge.pendingOwner.selector;
        excludes[5] = cbridge.setApprovalForBridge.selector;
        excludes[6] = cbridge.triggerRefund.selector;

        return excludes;
    }
}
