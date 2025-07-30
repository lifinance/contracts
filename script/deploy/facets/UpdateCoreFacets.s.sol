// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    error FailedToReadCoreFacetsFromConfig();

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        // Read core facets dynamically from global.json config
        string memory globalConfigPath = string.concat(
            vm.projectRoot(),
            "/config/global.json"
        );
        string memory globalConfig = vm.readFile(globalConfigPath);
        string[] memory coreFacets = globalConfig.readStringArray(
            ".coreFacets"
        );

        emit log("Core facets found in config/global.json: ");
        emit log_uint(coreFacets.length);

        bytes4[] memory exclude;

        // Check if the loupe was already added to the diamond
        bool loupeExists;
        try loupe.facetAddresses() returns (address[] memory) {
            // If call was successful, loupe exists on diamond already
            loupeExists = true;
        } catch {
            // No need to do anything, just making sure that the flow continues in both cases with try/catch
        }

        // Handle DiamondLoupeFacet separately as it needs special treatment
        if (!loupeExists) {
            address diamondLoupeAddress = _getConfigContractAddress(
                path,
                ".DiamondLoupeFacet"
            );
            bytes4[] memory loupeSelectors = getSelectors(
                "DiamondLoupeFacet",
                exclude
            );

            buildInitialCut(loupeSelectors, diamondLoupeAddress);
            vm.startBroadcast(deployerPrivateKey);
            if (cut.length > 0) {
                cutter.diamondCut(cut, address(0), "");
            }
            vm.stopBroadcast();

            // Reset diamond cut variable to remove diamondLoupe information
            delete cut;
        }

        // Process all core facets dynamically
        for (uint256 i = 0; i < coreFacets.length; i++) {
            string memory facetName = coreFacets[i];

            // Skip DiamondLoupeFacet as it was already handled
            if (
                keccak256(bytes(facetName)) ==
                keccak256(bytes("DiamondLoupeFacet"))
            ) {
                continue;
            }

            // Use _getConfigContractAddress which validates the contract exists
            address facetAddress = _getConfigContractAddress(
                path,
                string.concat(".", facetName)
            );
            bytes4[] memory selectors = getSelectors(facetName, exclude);

            if (loupeExists) {
                buildDiamondCut(selectors, facetAddress);
            } else {
                buildInitialCut(selectors, facetAddress);
            }
        }

        // If noBroadcast is activated, we only prepare calldata for sending it to multisig SAFE
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
