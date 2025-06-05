// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        address diamondLoupe = _getConfigContractAddress(
            path,
            ".DiamondLoupeFacet"
        );
        address ownership = _getConfigContractAddress(path, ".OwnershipFacet");
        address withdraw = _getConfigContractAddress(path, ".WithdrawFacet");
        address whitelistMgr = _getConfigContractAddress(
            path,
            ".WhitelistManagerFacet"
        );
        address accessMgr = _getConfigContractAddress(
            path,
            ".AccessManagerFacet"
        );
        address peripheryRgs = _getConfigContractAddress(
            path,
            ".PeripheryRegistryFacet"
        );
        address genSwapAddress = _getConfigContractAddress(
            path,
            ".GenericSwapFacet"
        );
        address genSwapV3Address = _getConfigContractAddress(
            path,
            ".GenericSwapFacetV3"
        );
        address calldVerifAddress = _getConfigContractAddress(
            path,
            ".CalldataVerificationFacet"
        );
        address emergencyPauseAddress = _getConfigContractAddress(
            path,
            ".EmergencyPauseFacet"
        );

        bytes4[] memory exclude;

        // check if the loupe was already added to the diamond
        bool loupeExists;
        try loupe.facetAddresses() returns (address[] memory) {
            // if call was successful, loupe exists on diamond already
            loupeExists = true;
        } catch {
            // no need to do anything, just making sure that the flow continues in both cases with try/catch
        }

        // Diamond Loupe
        bytes4[] memory selectors = getSelectors("DiamondLoupeFacet", exclude);

        if (!loupeExists) {
            buildInitialCut(selectors, diamondLoupe);
            vm.startBroadcast(deployerPrivateKey);
            if (cut.length > 0) {
                cutter.diamondCut(cut, address(0), "");
            }
            vm.stopBroadcast();
        }

        // reset diamond cut variable to remove diamondLoupe information
        delete cut;

        // Ownership Facet
        selectors = getSelectors("OwnershipFacet", exclude);
        if (loupeExists) {
            buildDiamondCut(selectors, ownership);
        } else {
            buildInitialCut(selectors, ownership);
        }

        // Withdraw Facet
        selectors = getSelectors("WithdrawFacet", exclude);
        if (loupeExists) {
            buildDiamondCut(selectors, withdraw);
        } else {
            buildInitialCut(selectors, withdraw);
        }

        // Whitelist Manager Facet
        selectors = getSelectors("WhitelistManagerFacet", exclude);
        if (loupeExists) {
            buildDiamondCut(selectors, whitelistMgr);
        } else {
            buildInitialCut(selectors, whitelistMgr);
        }

        // Access Manager Facet
        selectors = getSelectors("AccessManagerFacet", exclude);
        if (loupeExists) {
            buildDiamondCut(selectors, accessMgr);
        } else {
            buildInitialCut(selectors, accessMgr);
        }

        // PeripheryRegistry
        selectors = getSelectors("PeripheryRegistryFacet", exclude);
        if (loupeExists) {
            buildDiamondCut(selectors, peripheryRgs);
        } else {
            buildInitialCut(selectors, peripheryRgs);
        }

        // GenericSwapFacet
        selectors = getSelectors("GenericSwapFacet", exclude);
        if (loupeExists) {
            buildDiamondCut(selectors, genSwapAddress);
        } else {
            buildInitialCut(selectors, genSwapAddress);
        }

        // GenericSwapFacetV3
        selectors = getSelectors("GenericSwapFacetV3", exclude);
        if (loupeExists) {
            buildDiamondCut(selectors, genSwapV3Address);
        } else {
            buildInitialCut(selectors, genSwapV3Address);
        }

        // CalldataVerificationFacet
        selectors = getSelectors("CalldataVerificationFacet", exclude);
        if (loupeExists) {
            buildDiamondCut(selectors, calldVerifAddress);
        } else {
            buildInitialCut(selectors, calldVerifAddress);
        }

        // EmergencyPauseFacet
        selectors = getSelectors("EmergencyPauseFacet", exclude);
        if (loupeExists) {
            buildDiamondCut(selectors, emergencyPauseAddress);
        } else {
            buildInitialCut(selectors, emergencyPauseAddress);
        }

        // if noBroadcast is activated, we only prepare calldata for sending it to multisig SAFE
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

        vm.stopBroadcast();

        facets = loupe.facetAddresses();
    }
}
