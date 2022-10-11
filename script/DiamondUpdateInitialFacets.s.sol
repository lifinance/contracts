// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { stdJson } from "forge-std/StdJson.sol";
import "forge-std/console.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";

contract DeployScript is Script {
    using stdJson for string;

    IDiamondCut.FacetCut[] internal cut;

    function run() public {
        uint256 deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        string memory network = vm.envString("NETWORK");

        string memory root = vm.projectRoot();
        string memory path = string.concat(root, "/deployments/", network, ".json");
        string memory json = vm.readFile(path);
        address diamond = json.readAddress(".LiFiDiamond");
        address diamondLoupe = json.readAddress(".DiamondLoupeFacet");
        address ownership = json.readAddress(".OwnershipFacet");

        vm.startBroadcast(deployerPrivateKey);

        DiamondCutFacet cutter = DiamondCutFacet(diamond);

        bytes4[] memory functionSelectors;

        // Diamond Loupe

        functionSelectors = new bytes4[](5);
        functionSelectors[0] = DiamondLoupeFacet.facetFunctionSelectors.selector;
        functionSelectors[1] = DiamondLoupeFacet.facets.selector;
        functionSelectors[2] = DiamondLoupeFacet.facetAddress.selector;
        functionSelectors[3] = DiamondLoupeFacet.facetAddresses.selector;
        functionSelectors[4] = DiamondLoupeFacet.supportsInterface.selector;
        cut.push(
            IDiamondCut.FacetCut({
                facetAddress: address(diamondLoupe),
                action: IDiamondCut.FacetCutAction.Add,
                functionSelectors: functionSelectors
            })
        );

        // Ownership Facet

        functionSelectors = new bytes4[](4);
        functionSelectors[0] = OwnershipFacet.transferOwnership.selector;
        functionSelectors[1] = OwnershipFacet.cancelOwnershipTransfer.selector;
        functionSelectors[2] = OwnershipFacet.confirmOwnershipTransfer.selector;
        functionSelectors[3] = OwnershipFacet.owner.selector;

        cut.push(
            IDiamondCut.FacetCut({
                facetAddress: address(ownership),
                action: IDiamondCut.FacetCutAction.Add,
                functionSelectors: functionSelectors
            })
        );

        cutter.diamondCut(cut, address(0), "");

        vm.stopBroadcast();
    }
}
