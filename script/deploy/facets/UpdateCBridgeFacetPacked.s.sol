// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { CBridgeFacetPacked } from "lifi/Facets/CBridgeFacetPacked.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        address facet = json.readAddress(".CBridgeFacetPacked");

        CBridgeFacetPacked cbridge;
        bytes4[] memory exclude = new bytes4[](7);
        exclude[0] = cbridge.cancelOwnershipTransfer.selector;
        exclude[1] = cbridge.transferOwnership.selector;
        exclude[2] = cbridge.confirmOwnershipTransfer.selector;
        exclude[3] = cbridge.owner.selector;
        exclude[4] = cbridge.pendingOwner.selector;
        exclude[5] = cbridge.setApprovalForBridge.selector;
        exclude[6] = cbridge.triggerRefund.selector;
        buildDiamondCut(getSelectors("CBridgeFacetPacked", exclude), facet);
        if (noBroadcast) {
            if (cut.length > 0) {
                cutData = abi.encodeWithSelector(
                    DiamondCutFacet.diamondCut.selector,
                    cut,
                    address(0),
                    ""
                );
            }
            return (facets, cutData);
        }

        vm.startBroadcast(deployerPrivateKey);
        if (cut.length > 0) {
            cutter.diamondCut(cut, address(0), "");
        }
        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
