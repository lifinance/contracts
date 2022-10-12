// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import "forge-std/console.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { WithdrawFacet } from "lifi/Facets/WithdrawFacet.sol";
import { DexManagerFacet } from "lifi/Facets/DexManagerFacet.sol";
import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public {
        string memory root = vm.projectRoot();
        string memory path = string.concat(root, "/deployments/", network, ".json");
        string memory json = vm.readFile(path);
        address diamondLoupe = json.readAddress(".DiamondLoupeFacet");
        address ownership = json.readAddress(".OwnershipFacet");
        address withdraw = json.readAddress(".WithdrawFacet");
        address dexMgr = json.readAddress(".DexManagerFacet");
        address accessMgr = json.readAddress(".AccessManagerFacet");

        vm.startBroadcast(deployerPrivateKey);

        bytes4[] memory functionSelectors;

        // Diamond Loupe
        if (loupe.facetFunctionSelectors(diamondLoupe).length == 0) {
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
        }

        // Ownership Facet
        if (loupe.facetFunctionSelectors(ownership).length == 0) {
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
        }
        // Withdraw Facet
        if (loupe.facetFunctionSelectors(withdraw).length == 0) {
            functionSelectors = new bytes4[](2);
            functionSelectors[0] = WithdrawFacet.executeCallAndWithdraw.selector;
            functionSelectors[1] = WithdrawFacet.withdraw.selector;
            cut.push(
                IDiamondCut.FacetCut({
                    facetAddress: withdraw,
                    action: IDiamondCut.FacetCutAction.Add,
                    functionSelectors: functionSelectors
                })
            );
        }

        // Dex Manager Facet
        if (loupe.facetFunctionSelectors(dexMgr).length == 0) {
            functionSelectors = new bytes4[](8);
            functionSelectors[0] = DexManagerFacet.addDex.selector;
            functionSelectors[1] = DexManagerFacet.batchAddDex.selector;
            functionSelectors[2] = DexManagerFacet.removeDex.selector;
            functionSelectors[3] = DexManagerFacet.batchRemoveDex.selector;
            functionSelectors[4] = DexManagerFacet.setFunctionApprovalBySignature.selector;
            functionSelectors[5] = DexManagerFacet.batchSetFunctionApprovalBySignature.selector;
            functionSelectors[6] = DexManagerFacet.isFunctionApproved.selector;
            functionSelectors[7] = DexManagerFacet.approvedDexs.selector;

            cut.push(
                IDiamondCut.FacetCut({
                    facetAddress: dexMgr,
                    action: IDiamondCut.FacetCutAction.Add,
                    functionSelectors: functionSelectors
                })
            );
        }

        // Access Manager Facet
        if (loupe.facetFunctionSelectors(accessMgr).length == 0) {
            functionSelectors = new bytes4[](2);
            functionSelectors[0] = AccessManagerFacet.setCanExecute.selector;
            functionSelectors[1] = AccessManagerFacet.addressCanExecuteMethod.selector;

            cut.push(
                IDiamondCut.FacetCut({
                    facetAddress: accessMgr,
                    action: IDiamondCut.FacetCutAction.Add,
                    functionSelectors: functionSelectors
                })
            );
        }

        cutter.diamondCut(cut, address(0), "");

        vm.stopBroadcast();
    }
}
