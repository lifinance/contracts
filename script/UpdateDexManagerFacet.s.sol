// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import "forge-std/console.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { DexManagerFacet } from "lifi/Facets/DexManagerFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;
    bytes4[] sigs;

    function run() public returns (address[] memory facets) {
        string memory root = vm.projectRoot();
        string memory path = string.concat(root, "/deployments/", network, ".json");
        string memory json = vm.readFile(path);
        address facet = json.readAddress(".DexManagerFacet");

        path = string.concat(root, "/config/dexs.json");
        json = vm.readFile(path);
        address[] memory dexs = json.readAddressArray(string.concat(".", network));

        path = string.concat(root, "/config/sigs.json");
        json = vm.readFile(path);
        bytes[] memory rawSigs = json.readBytesArray(".sigs");
        for (uint256 i = 0; i < rawSigs.length; i++) {
            sigs.push(bytes4(rawSigs[i]));
        }

        vm.startBroadcast(deployerPrivateKey);

        // DexManager
        if (loupe.facetFunctionSelectors(facet).length == 0) {
            bytes4[] memory exclude;
            cut.push(
                IDiamondCut.FacetCut({
                    facetAddress: address(facet),
                    action: IDiamondCut.FacetCutAction.Add,
                    functionSelectors: getSelectors("DexManagerFacet", exclude)
                })
            );
            cutter.diamondCut(cut, address(0), "");
        }

        if (dexs.length > 0) {
            DexManagerFacet(address(diamond)).batchAddDex(dexs);
        }

        if (sigs.length > 0) {
            DexManagerFacet(address(diamond)).batchSetFunctionApprovalBySignature(sigs, true);
        }

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
