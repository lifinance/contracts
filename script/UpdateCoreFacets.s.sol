// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet, IDiamondLoupe } from "lifi/Facets/DiamondLoupeFacet.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { WithdrawFacet } from "lifi/Facets/WithdrawFacet.sol";
import { DexManagerFacet } from "lifi/Facets/DexManagerFacet.sol";
import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public returns (address[] memory facets) {
        address diamondLoupe = json.readAddress(".DiamondLoupeFacet");
        address ownership = json.readAddress(".OwnershipFacet");
        address withdraw = json.readAddress(".WithdrawFacet");
        address dexMgr = json.readAddress(".DexManagerFacet");
        address accessMgr = json.readAddress(".AccessManagerFacet");
        address peripheryRgs = json.readAddress(".PeripheryRegistryFacet");

        vm.startBroadcast(deployerPrivateKey);

        bytes4[] memory exclude;

        // Diamond Loupe
        buildDiamondCut(
            getSelectors("DiamondLoupeFacet", exclude),
            diamondLoupe
        );

        // Ownership Facet
        buildDiamondCut(getSelectors("OwnershipFacet", exclude), ownership);

        // Withdraw Facet
        buildDiamondCut(getSelectors("WithdrawFacet", exclude), withdraw);

        // Dex Manager Facet
        buildDiamondCut(getSelectors("DexManagerFacet", exclude), dexMgr);

        // Access Manager Facet
        buildDiamondCut(
            getSelectors("AccessManagerFacet", exclude),
            accessMgr
        );

        // PeripheryRegistry
        buildDiamondCut(
            getSelectors("PeripheryRegistry", exclude),
            peripheryRgs
        );

        if (cut.length > 0) {
            cutter.diamondCut(cut, address(0), "");
        }

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
