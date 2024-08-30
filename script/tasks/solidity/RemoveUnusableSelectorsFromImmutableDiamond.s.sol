// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "../../deploy/facets/utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { CREATE3Factory } from "create3-factory/CREATE3Factory.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { WithdrawFacet } from "lifi/Facets/WithdrawFacet.sol";
import { DexManagerFacet } from "lifi/Facets/DexManagerFacet.sol";
import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";
import { CBridgeFacetPacked } from "lifi/Facets/CBridgeFacetPacked.sol";
import { HopFacet } from "lifi/Facets/HopFacet.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";
import { HopFacetPacked } from "lifi/Facets/HopFacetPacked.sol";
import { OptimismBridgeFacet } from "lifi/Facets/OptimismBridgeFacet.sol";
import { StargateFacet } from "lifi/Facets/StargateFacet.sol";

contract DeployScript is UpdateScriptBase {
    bytes4[] internal selectors;

    struct FacetEntry {
        string name;
        string version;
    }

    using stdJson for string;

    function run() public returns (bool) {
        vm.startBroadcast(deployerPrivateKey);

        // collect all function selectors that need to be removed
        // core facets
        selectors.push(OwnershipFacet.transferOwnership.selector);
        selectors.push(OwnershipFacet.cancelOwnershipTransfer.selector);
        selectors.push(OwnershipFacet.confirmOwnershipTransfer.selector);
        selectors.push(WithdrawFacet.executeCallAndWithdraw.selector);
        selectors.push(DexManagerFacet.addDex.selector);
        selectors.push(DexManagerFacet.batchAddDex.selector);
        selectors.push(DexManagerFacet.removeDex.selector);
        selectors.push(DexManagerFacet.batchRemoveDex.selector);
        selectors.push(
            DexManagerFacet.setFunctionApprovalBySignature.selector
        );
        selectors.push(
            DexManagerFacet.batchSetFunctionApprovalBySignature.selector
        );
        selectors.push(AccessManagerFacet.setCanExecute.selector);
        selectors.push(
            PeripheryRegistryFacet.registerPeripheryContract.selector
        );

        // add facet-selectors to array if facet is registered in diamond
        // CBridgeFacetPacked
        if (
            DiamondLoupeFacet(diamond).facetAddress(
                CBridgeFacetPacked.setApprovalForBridge.selector
            ) != address(0)
        ) {
            selectors.push(CBridgeFacetPacked.setApprovalForBridge.selector);
        }

        // HopFacet
        if (
            DiamondLoupeFacet(diamond).facetAddress(
                HopFacet.registerBridge.selector
            ) != address(0)
        ) {
            selectors.push(HopFacet.registerBridge.selector);
        }

        // HopFacetOptimized
        if (
            DiamondLoupeFacet(diamond).facetAddress(
                HopFacetOptimized.setApprovalForBridges.selector
            ) != address(0)
        ) {
            selectors.push(HopFacetOptimized.setApprovalForBridges.selector);
        }

        // HopFacetPacked
        if (
            DiamondLoupeFacet(diamond).facetAddress(
                HopFacetPacked.setApprovalForHopBridges.selector
            ) != address(0)
        ) {
            selectors.push(HopFacetPacked.setApprovalForHopBridges.selector);
        }

        // OptimismBridgeFacet
        if (
            DiamondLoupeFacet(diamond).facetAddress(
                OptimismBridgeFacet.registerOptimismBridge.selector
            ) != address(0)
        ) {
            selectors.push(
                OptimismBridgeFacet.registerOptimismBridge.selector
            );
        }

        // StargateFacet
        if (
            DiamondLoupeFacet(diamond).facetAddress(
                StargateFacet.setLayerZeroChainId.selector
            ) != address(0)
        ) {
            selectors.push(StargateFacet.setLayerZeroChainId.selector);
        }

        // create diamondCut action to remove all facet collectors that have been added to the array
        cut.push(
            LibDiamond.FacetCut({
                facetAddress: address(0),
                action: LibDiamond.FacetCutAction.Remove,
                functionSelectors: selectors
            })
        );

        // execute diamondCut
        cutter.diamondCut(cut, address(0), "");

        vm.stopBroadcast();
        return true;
    }
}
