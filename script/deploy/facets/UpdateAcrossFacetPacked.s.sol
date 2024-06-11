// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { AcrossFacetPacked } from "lifi/Facets/AcrossFacetPacked.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("AcrossFacetPacked");
    }

    function getExcludes() internal view override returns (bytes4[] memory) {
        AcrossFacetPacked across;
        bytes4[] memory excludes = new bytes4[](7);
        excludes[0] = across.cancelOwnershipTransfer.selector;
        excludes[1] = across.transferOwnership.selector;
        excludes[2] = across.confirmOwnershipTransfer.selector;
        excludes[3] = across.owner.selector;
        excludes[4] = across.pendingOwner.selector;
        excludes[5] = across.setApprovalForBridge.selector;
        excludes[6] = across.executeCallAndWithdraw.selector;

        return excludes;
    }
}
