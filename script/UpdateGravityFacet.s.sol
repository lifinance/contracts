// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { GravityFacet } from "lifi/Facets/GravityFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public returns (address[] memory facets) {
        string memory path = string.concat(root, "/deployments/", network, ".", fileSuffix, "json");
        string memory json = vm.readFile(path);
        address facetAddress = json.readAddress(".GravityFacet");

        vm.startBroadcast(deployerPrivateKey);

        if (loupe.facetFunctionSelectors(facetAddress).length == 0) {
            bytes4[] memory exclude;
            cut.push(
                IDiamondCut.FacetCut({
                    facetAddress: facetAddress,
                    action: IDiamondCut.FacetCutAction.Add,
                    functionSelectors: getSelectors("GravityFacet", exclude)
                })
            );
            cutter.diamondCut(cut, address(0), "");
        }

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
