// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { AcrossFacetPackedV4 } from "lifi/Facets/AcrossFacetPackedV4.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("AcrossFacetPackedV4");
    }

    function getExcludes() internal view override returns (bytes4[] memory) {
        AcrossFacetPackedV4 acrossV4;
        bytes4[] memory excludes = new bytes4[](9);
        excludes[0] = acrossV4.cancelOwnershipTransfer.selector;
        excludes[1] = acrossV4.transferOwnership.selector;
        excludes[2] = acrossV4.confirmOwnershipTransfer.selector;
        excludes[3] = acrossV4.owner.selector;
        excludes[4] = acrossV4.pendingOwner.selector;
        excludes[5] = acrossV4.setApprovalForBridge.selector;
        excludes[6] = acrossV4.executeCallAndWithdraw.selector;
        excludes[7] = acrossV4.SPOKEPOOL.selector;
        excludes[8] = acrossV4.WRAPPED_NATIVE.selector;

        return excludes;
    }
}
