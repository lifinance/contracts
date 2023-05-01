// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { CBridgeFacetPacked } from "lifi/Facets/CBridgeFacetPacked.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public returns (address[] memory facets) {
        address facet = json.readAddress(".CBridgeFacetPacked");

        vm.startBroadcast(deployerPrivateKey);

        bytes4[] memory exclude = new bytes4[](5);
        exclude[0] = 0x23452b9c;
        exclude[1] = 0x7200b829;
        exclude[2] = 0x8da5cb5b;
        exclude[3] = 0xe30c3978;
        exclude[4] = 0xf2fde38b;
        buildDiamondCut(getSelectors("CBridgeFacetPacked", exclude), facet);
        if (cut.length > 0) {
            cutter.diamondCut(cut, address(0), "");
        }
        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
