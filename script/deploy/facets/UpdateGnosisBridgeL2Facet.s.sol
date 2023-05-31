// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { GnosisBridgeL2Facet } from "lifi/Facets/GnosisBridgeL2Facet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public returns (address[] memory facets) {
        address facet = json.readAddress(".GnosisBridgeL2Facet");

        vm.startBroadcast(deployerPrivateKey);

        // GnosisBridge
        bytes4[] memory exclude;
        buildDiamondCut(getSelectors("GnosisBridgeL2Facet", exclude), facet);
        if (cut.length > 0) {
            cutter.diamondCut(cut, address(0), "");
        }
        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
