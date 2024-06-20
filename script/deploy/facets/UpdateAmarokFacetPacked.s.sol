// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { AmarokFacetPacked } from "lifi/Facets/AmarokFacetPacked.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("AmarokFacetPacked");
    }

    function getExcludes() internal view override returns (bytes4[] memory) {
        AmarokFacetPacked amarok;
        bytes4[] memory excludes = new bytes4[](6);
        excludes[0] = amarok.cancelOwnershipTransfer.selector;
        excludes[1] = amarok.transferOwnership.selector;
        excludes[2] = amarok.confirmOwnershipTransfer.selector;
        excludes[3] = amarok.owner.selector;
        excludes[4] = amarok.pendingOwner.selector;
        excludes[5] = amarok.setApprovalForBridge.selector;

        return excludes;
    }
}
