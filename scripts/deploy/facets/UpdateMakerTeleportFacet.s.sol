// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { MakerTeleportFacet } from "lifi/Facets/MakerTeleportFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, IDiamondCut.FacetCut[] memory cut)
    {
        string memory path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );
        string memory json = vm.readFile(path);
        address facet = json.readAddress(".MakerTeleportFacet");

        vm.startBroadcast(deployerPrivateKey);

        // MakerTeleport
        bytes4[] memory exclude;
        buildDiamondCut(getSelectors("MakerTeleportFacet", exclude), facet);
        if (cut.length > 0) {
            cutter.diamondCut(cut, address(0), "");
        }
        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
