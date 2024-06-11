// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { AcrossFacetPackedV3 } from "lifi/Facets/AcrossFacetPackedV3.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("AcrossFacetPackedV3");
    }

    function getExcludes() internal view override returns (bytes4[] memory) {
        AcrossFacetPackedV3 acrossV3;
        bytes4[] memory excludes = new bytes4[](7);
        excludes[0] = acrossV3.cancelOwnershipTransfer.selector;
        excludes[1] = acrossV3.transferOwnership.selector;
        excludes[2] = acrossV3.confirmOwnershipTransfer.selector;
        excludes[3] = acrossV3.owner.selector;
        excludes[4] = acrossV3.pendingOwner.selector;
        excludes[5] = acrossV3.setApprovalForBridge.selector;
        excludes[6] = acrossV3.executeCallAndWithdraw.selector;

        return excludes;
    }
}
