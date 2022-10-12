// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { stdJson } from "forge-std/StdJson.sol";
import "forge-std/console.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";

contract UpdateScriptBase is Script {
    using stdJson for string;

    address internal diamond;
    IDiamondCut.FacetCut[] internal cut;
    DiamondCutFacet internal cutter;
    DiamondLoupeFacet internal loupe;
    uint256 internal deployerPrivateKey;
    string internal network;

    constructor() {
        deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        network = vm.envString("NETWORK");

        string memory root = vm.projectRoot();
        string memory path = string.concat(root, "/deployments/", network, ".json");
        string memory json = vm.readFile(path);
        diamond = json.readAddress(".LiFiDiamond");
        cutter = DiamondCutFacet(diamond);
        loupe = DiamondLoupeFacet(diamond);
    }
}
