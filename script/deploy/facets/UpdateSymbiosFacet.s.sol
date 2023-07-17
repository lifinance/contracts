// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { SymbiosisFacet } from "lifi/Facets/SymbiosisFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public returns (address[] memory facets, bytes memory cutData) {
        address facet = json.readAddress(".SymbiosisFacet");

        path = string.concat(root, "/config/symbiosis.json");

        json = vm.readFile(path);

        bytes4[] memory exclude;
        buildDiamondCut(getSelectors("SymbiosisFacet", exclude), facet);

        if (noBroadcast) {
            if (cut.length > 0) {
                cutData = abi.encodeWithSelector(
                    DiamondCutFacet.diamondCut.selector,
                    cut,
                    address(facet),
                    ""
                );
            }
            return (facets, cutData);
        }

        vm.startBroadcast(deployerPrivateKey);
        if (cut.length > 0) {
            cutter.diamondCut(cut, address(facet), "");
        }
        facets = loupe.facetAddresses();

        vm.stopBroadcast();


    }
}
