// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import "forge-std/console.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { AmarokFacet } from "lifi/Facets/AmarokFacet.sol";
import {DSTest} from "ds-test/test.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public returns (address[] memory facets) {
        address facet = json.readAddress(".AmarokFacet");

        console.log("msg.sender1: ", msg.sender);
        vm.startBroadcast(deployerPrivateKey);

        // add Amarok facet to diamond
//        if (loupe.facetFunctionSelectors(facet).length == 0) {
//            bytes4[] memory exclude;
//            cut.push(
//                IDiamondCut.FacetCut({
//                    facetAddress: address(facet),
//                    action: IDiamondCut.FacetCutAction.Add,
//                    functionSelectors: getSelectors("AmarokFacet", exclude)
//                })
//            );
//            cutter.diamondCut(cut, address(0), "");
//        }

        console.log("deployerPrivateKey: ", deployerPrivateKey);
        console.log("msg.sender2: ", msg.sender);
        console.log("address(this): ", address(this));
        console.log("diamond: ", diamond);
        console.log("owner: ", OwnershipFacet(diamond).owner());
//
//        AmarokFacet(diamond).setAmarokDomain(uint256(1), uint32(6648936));
//        AmarokFacet(diamond).setAmarokDomain(uint256(10), uint32(1869640809));
//        AmarokFacet(diamond).setAmarokDomain(uint256(56), uint32(6450786));
//        AmarokFacet(diamond).setAmarokDomain(uint256(56), uint32(6450786));
//        AmarokFacet(diamond).setAmarokDomain(uint256(100), uint32(6778479));
//        AmarokFacet(diamond).setAmarokDomain(uint256(137), uint32(1886350457));
//        AmarokFacet(diamond).setAmarokDomain(uint256(1284), uint32(1650811245));
//        AmarokFacet(diamond).setAmarokDomain(uint256(42161), uint32(1634886255));

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
