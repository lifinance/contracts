// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { console, UpdateScriptBase } from "../../deploy/facets/utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { CREATE3Factory } from "create3-factory/CREATE3Factory.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { WithdrawFacet } from "lifi/Facets/WithdrawFacet.sol";
import { DexManagerFacet } from "lifi/Facets/DexManagerFacet.sol";
import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";
import { AxelarFacet } from "lifi/Facets/AxelarFacet.sol";
import { CBridgeFacetPacked } from "lifi/Facets/CBridgeFacetPacked.sol";
import { HopFacet } from "lifi/Facets/HopFacet.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";
import { HopFacetPacked } from "lifi/Facets/HopFacetPacked.sol";
import { MultichainFacet } from "lifi/Facets/MultichainFacet.sol";
import { OFTWrapperFacet } from "lifi/Facets/OFTWrapperFacet.sol";
import { OptimismBridgeFacet } from "lifi/Facets/OptimismBridgeFacet.sol";
import { StargateFacet } from "lifi/Facets/StargateFacet.sol";

contract DeployScript is UpdateScriptBase {
    bytes4[] internal selectors;
    //    struct ContractSelectors {
    //        string contractName;
    //        bytes4[] functionSelectors;
    //    }

    struct FacetEntry {
        string name;
        string version;
    }

    using stdJson for string;

    function run() public returns (bool) {
        vm.startBroadcast(deployerPrivateKey);
//        console.log("in script RemoveUnusableSelectorsFromImmutableDiamond");

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
//        console.log("selectors to be removed: ", selectors.length);
//        console.log(
//            "return function: ",
//            DiamondLoupeFacet(diamond).facetAddress(
//                AxelarFacet.setChainName.selector
//            )
//        );
//        console.log("diamondAddress: ", diamond);

        // add facet-selectors if facet is registered in diamond
        // AxelarFacet
        if (
            DiamondLoupeFacet(diamond).facetAddress(
                AxelarFacet.setChainName.selector
            ) != address(0)
        ) {
//            console.log("in AxelarFacetBranch");
            selectors.push(AxelarFacet.setChainName.selector);
        }

        // CBridgeFacetPacked
        if (
            DiamondLoupeFacet(diamond).facetAddress(
                CBridgeFacetPacked.setApprovalForBridge.selector
            ) != address(0)
        ) {
//            console.log("in CBridgeFacetPackedBranch");
            // TODO: why is this selector not in louper?
            selectors.push(CBridgeFacetPacked.setApprovalForBridge.selector);
        }

        // HopFacet
        if (
            DiamondLoupeFacet(diamond).facetAddress(
                HopFacet.registerBridge.selector
            ) != address(0)
        ) {
//            console.log("in HopFacetBranch");
            selectors.push(HopFacet.registerBridge.selector);
        }

        // HopFacetOptimized
        if (
            DiamondLoupeFacet(diamond).facetAddress(
                HopFacetOptimized.setApprovalForBridges.selector
            ) != address(0)
        ) {
//            console.log("in HopFacetOptimizedBranch");
            selectors.push(HopFacetOptimized.setApprovalForBridges.selector);
        }

        // HopFacetPacked
        if (
            DiamondLoupeFacet(diamond).facetAddress(
                HopFacetPacked.setApprovalForHopBridges.selector
            ) != address(0)
        ) {
//            console.log("in HopFacetPackedBranch");
            selectors.push(HopFacetPacked.setApprovalForHopBridges.selector);
        }

        // MultichainFacet
        if (
            DiamondLoupeFacet(diamond).facetAddress(
                MultichainFacet.registerRouters.selector
            ) != address(0)
        ) {
//            console.log("in MultichainBranch");
            selectors.push(MultichainFacet.registerRouters.selector);
            selectors.push(MultichainFacet.updateAddressMappings.selector);
        }

        // OFTWrapperFacet
        if (
            DiamondLoupeFacet(diamond).facetAddress(
                OFTWrapperFacet.setOFTLayerZeroChainId.selector
            ) != address(0)
        ) {
//            console.log("in OFTWrapperFacetBranch");
            selectors.push(OFTWrapperFacet.setOFTLayerZeroChainId.selector);
        }

        // OptimismBridgeFacet
        if (
            DiamondLoupeFacet(diamond).facetAddress(
                OptimismBridgeFacet.registerOptimismBridge.selector
            ) != address(0)
        ) {
//            console.log("in OptimismBridgeFacetBranch");
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
//            console.log("in OptimismBridgeFacetBranch");
            selectors.push(StargateFacet.setLayerZeroChainId.selector);
        }

        cut.push(
            IDiamondCut.FacetCut({
                facetAddress: address(0),
                action: IDiamondCut.FacetCutAction.Remove,
                functionSelectors: selectors
            })
        );

        // remove selectors from diamond contract
        cutter.diamondCut(cut, address(0), "");

        vm.stopBroadcast();
        return true;
    }
}
