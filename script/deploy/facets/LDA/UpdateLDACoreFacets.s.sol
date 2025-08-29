// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateLDAScriptBase } from "./utils/UpdateLDAScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { LDADiamondCutFacet } from "lifi/Periphery/LDA/Facets/LDADiamondCutFacet.sol";

contract UpdateLDACoreFacets is UpdateLDAScriptBase {
    using stdJson for string;

    error FailedToReadLDACoreFacetsFromConfig();

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        // Read LDA core facets dynamically from lda-global.json config
        string memory ldaGlobalConfigPath = string.concat(
            vm.projectRoot(),
            "/config/global.json"
        );
        string memory ldaGlobalConfig = vm.readFile(ldaGlobalConfigPath);
        string[] memory ldaCoreFacets = ldaGlobalConfig.readStringArray(
            ".ldaCoreFacets"
        );

        emit log("LDA core facets found in config/global.json: ");
        emit log_uint(ldaCoreFacets.length);

        bytes4[] memory exclude;

        // Check if the LDA loupe was already added to the diamond
        bool loupeExists;
        try loupe.facetAddresses() returns (address[] memory) {
            // If call was successful, loupe exists on LDA diamond already
            emit log("LDA Loupe exists on diamond already");
            loupeExists = true;
        } catch {
            // No need to do anything, just making sure that the flow continues in both cases with try/catch
        }

        // Handle LDADiamondLoupeFacet separately as it needs special treatment
        if (!loupeExists) {
            emit log("LDA Loupe does not exist on diamond yet");
            address ldaDiamondLoupeAddress = _getConfigContractAddress(
                path,
                ".LDADiamondLoupeFacet"
            );
            bytes4[] memory loupeSelectors = getSelectors(
                "LDADiamondLoupeFacet",
                exclude
            );

            buildInitialCut(loupeSelectors, ldaDiamondLoupeAddress);
            vm.startBroadcast(deployerPrivateKey);
            if (cut.length > 0) {
                cutter.diamondCut(cut, address(0), "");
            }
            vm.stopBroadcast();

            // Reset diamond cut variable to remove LDA diamondLoupe information
            delete cut;
        }

        // Process all LDA core facets dynamically
        for (uint256 i = 0; i < ldaCoreFacets.length; i++) {
            string memory facetName = ldaCoreFacets[i];

            // Skip LDADiamondCutFacet and LDADiamondLoupeFacet as they were already handled
            if (
                keccak256(bytes(facetName)) ==
                keccak256(bytes("LDADiamondLoupeFacet"))
            ) {
                continue;
            }
            // Skip LDADiamondCutFacet as it was already handled during LDA diamond deployment
            if (
                keccak256(bytes(facetName)) ==
                keccak256(bytes("LDADiamondCutFacet"))
            ) {
                continue;
            }

            emit log("Now adding LDA facet: ");
            emit log(facetName);
            // Use _getConfigContractAddress which validates the contract exists
            address facetAddress = _getConfigContractAddress(
                path,
                string.concat(".", facetName)
            );
            bytes4[] memory selectors = getSelectors(facetName, exclude);

            // at this point we know for sure that LDA diamond loupe exists on diamond
            buildDiamondCut(selectors, facetAddress);
        }

        // If noBroadcast is activated, we only prepare calldata for sending it to multisig SAFE
        if (noBroadcast) {
            if (cut.length > 0) {
                cutData = abi.encodeWithSelector(
                    LDADiamondCutFacet.diamondCut.selector,
                    cut,
                    address(0),
                    ""
                );
            }
            emit log("=== DIAMOND CUT CALLDATA FOR MANUAL EXECUTION ===");
            emit log_bytes(cutData);
            emit log("=== END CALLDATA ===");
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
