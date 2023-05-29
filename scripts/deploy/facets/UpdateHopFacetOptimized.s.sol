// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    struct Approval {
        address a_tokenAddress;
        address b_contractAddress;
        string c_tokenName;
        string d_contractName;
    }

    address[] internal contractAddresses;
    address[] internal tokenAddresses;

    function run()
        public
        returns (
            address[] memory facets,
            IDiamondCut.FacetCut[] memory facetCut
        )
    {
        address facet = json.readAddress(".HopFacetOptimized");

        path = string.concat(root, "/config/hop.json");
        json = vm.readFile(path);
        bytes memory rawApprovals = json.parseRaw(
            string.concat(".", network, ".approvals")
        );
        Approval[] memory approvals = abi.decode(rawApprovals, (Approval[]));

        // Loop through all items and split them in arrays
        for (uint256 i = 0; i < approvals.length; i++) {
            contractAddresses.push(approvals[i].b_contractAddress);
            tokenAddresses.push(approvals[i].a_tokenAddress);
        }

        bytes memory callData = abi.encodeWithSelector(
            HopFacetOptimized.setApprovalForBridges.selector,
            contractAddresses,
            tokenAddresses
        );

        // Hop Optimized
        bytes4[] memory exclude;
        buildDiamondCut(getSelectors("HopFacetOptimized", exclude), facet);
        if (noBroadcast) {
            return (facets, cut);
        }

        vm.startBroadcast(deployerPrivateKey);
        if (cut.length > 0) {
            cutter.diamondCut(cut, address(facet), callData);
        }
        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
