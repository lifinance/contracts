// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    address facet;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
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

        bytes4[] memory exclude;
        // build diamond cut depending on which diamond the CelerIMFacet should be added to
        if (useDefaultDiamond) {
            facet = json.readAddress(".CelerIMFacetMutable");
            buildDiamondCut(
                getSelectors("CelerIMFacetMutable", exclude),
                facet
            );
        } else {
            facet = json.readAddress(".CelerIMFacetImmutable");
            buildDiamondCut(
                getSelectors("CelerIMFacetImmutable", exclude),
                facet
            );
        }

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
