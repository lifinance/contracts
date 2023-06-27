// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase, console } from "./utils/UpdateScriptBase.sol";
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

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        address diamondLoupe = json.readAddress(".DiamondLoupeFacet");
        address ownership = json.readAddress(".OwnershipFacet");
        address withdraw = json.readAddress(".WithdrawFacet");
        address dexMgr = json.readAddress(".DexManagerFacet");
        address accessMgr = json.readAddress(".AccessManagerFacet");
        address peripheryRgs = json.readAddress(".PeripheryRegistryFacet");

        bytes4[] memory exclude;

        (bool loupeExists, ) = address(loupe).staticcall(
            abi.encodeWithSelector(loupe.facetAddresses.selector)
        );

        // Diamond Loupe
        bytes4[] memory loupeSelectors = getSelectors(
            "DiamondLoupeFacet",
            exclude
        );

        if (!loupeExists) {
            buildInitialCut(loupeSelectors, diamondLoupe);
        }

        // Ownership Facet
        bytes4[] memory ownershipSelectors = getSelectors(
            "OwnershipFacet",
            exclude
        );
        if (loupeExists) {
            buildDiamondCut(ownershipSelectors, ownership);
        } else {
            buildInitialCut(ownershipSelectors, ownership);
        }

        // Withdraw Facet
        bytes4[] memory withdrawSelectors = getSelectors(
            "WithdrawFacet",
            exclude
        );
        if (loupeExists) {
            buildDiamondCut(withdrawSelectors, withdraw);
        } else {
            buildInitialCut(withdrawSelectors, withdraw);
        }

        // Dex Manager Facet
        bytes4[] memory dexMgrSelectors = getSelectors(
            "DexManagerFacet",
            exclude
        );
        if (loupeExists) {
            buildDiamondCut(dexMgrSelectors, dexMgr);
        } else {
            buildInitialCut(dexMgrSelectors, dexMgr);
        }

        // Access Manager Facet
        bytes4[] memory accessMgrSelectors = getSelectors(
            "AccessManagerFacet",
            exclude
        );
        if (loupeExists) {
            buildDiamondCut(accessMgrSelectors, accessMgr);
        } else {
            buildInitialCut(accessMgrSelectors, accessMgr);
        }

        // PeripheryRegistry
        bytes4[] memory peripheryRgsSelectors = getSelectors(
            "PeripheryRegistryFacet",
            exclude
        );
        if (loupeExists) {
            buildDiamondCut(peripheryRgsSelectors, peripheryRgs);
        } else {
            buildInitialCut(peripheryRgsSelectors, peripheryRgs);
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

        console.log("broadcast pause");
        vm.startBroadcast(deployerPrivateKey);



        // approve refundWallet to execute certain functions (as defined in config/global.json)
        // exclude this step for localanvil network. Does not work there for some reason
        if (
            keccak256(abi.encodePacked(network)) !=
            keccak256(abi.encodePacked("localanvil"))
        ) approveRefundWallet();

        vm.stopBroadcast();
    }
}
