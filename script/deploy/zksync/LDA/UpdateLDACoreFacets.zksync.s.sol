// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateLDAScriptBase } from "./utils/UpdateLDAScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";

contract UpdateLDACoreFacets is UpdateLDAScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        // Read LDA core facets dynamically from global.json config
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
            emit log("DiamondLoupeFacet exists on diamond already");
            loupeExists = true;
        } catch {
            // No need to do anything, just making sure that the flow continues in both cases with try/catch
        }

        // Handle DiamondLoupeFacet separately as it needs special treatment
        if (!loupeExists) {
            emit log("DiamondLoupeFacet does not exist on diamond yet");
            // Read DiamondLoupeFacet from zkSync deployment file (same as regular script)
            address ldaDiamondLoupeAddress = _getConfigContractAddress(
                path,
                ".DiamondLoupeFacet"
            );

            bytes4[] memory loupeSelectors = getSelectors(
                "DiamondLoupeFacet",
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

            // Skip DiamondCutFacet and DiamondLoupeFacet as they were already handled
            if (
                keccak256(bytes(facetName)) ==
                keccak256(bytes("DiamondLoupeFacet"))
            ) {
                continue;
            }
            // Skip DiamondCutFacet as it was already handled during LDA diamond deployment
            if (
                keccak256(bytes(facetName)) ==
                keccak256(bytes("DiamondCutFacet"))
            ) {
                continue;
            }

            emit log("Now adding LDA core facet: ");
            emit log(facetName);
            // Read core facets from zkSync deployment file (same as regular script)
            address facetAddress = _getConfigContractAddress(
                path,
                string.concat(".", facetName)
            );

            bytes4[] memory selectors = getSelectors(facetName, exclude);

            // at this point we know for sure that diamond loupe exists on diamond
            buildDiamondCut(selectors, facetAddress);
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
