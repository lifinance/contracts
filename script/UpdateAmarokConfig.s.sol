// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import "forge-std/console.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { AmarokFacet } from "lifi/Facets/AmarokFacet.sol";


contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public returns (address[] memory facets) {
        address facet = json.readAddress(".AmarokFacet");

        vm.startBroadcast(deployerPrivateKey);

        AmarokFacet(diamond).setAmarokDomain(uint256(1), uint32(6648936));
        AmarokFacet(diamond).setAmarokDomain(uint256(10), uint32(1869640809));
        AmarokFacet(diamond).setAmarokDomain(uint256(56), uint32(6450786));
        AmarokFacet(diamond).setAmarokDomain(uint256(56), uint32(6450786));
        AmarokFacet(diamond).setAmarokDomain(uint256(100), uint32(6778479));
        AmarokFacet(diamond).setAmarokDomain(uint256(137), uint32(1886350457));
        AmarokFacet(diamond).setAmarokDomain(uint256(1284), uint32(1650811245));
        AmarokFacet(diamond).setAmarokDomain(uint256(42161), uint32(1634886255));

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
