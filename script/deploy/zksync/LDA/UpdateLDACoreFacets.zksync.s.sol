// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateLDAScriptBase } from "./utils/UpdateLDAScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";

contract UpdateLDACoreFacets is UpdateLDAScriptBase {
    using stdJson for string;

    /// @notice Get regular deployment file path (without lda. prefix)
    function getRegularDeploymentPath() internal view returns (string memory) {
        // Need to construct regular deployment path by removing "lda." prefix from fileSuffix
        string memory regularFileSuffix;
        bytes memory fileSuffixBytes = bytes(fileSuffix);

        // Check if fileSuffix starts with "lda." and remove it
        if (
            fileSuffixBytes.length >= 4 &&
            fileSuffixBytes[0] == "l" &&
            fileSuffixBytes[1] == "d" &&
            fileSuffixBytes[2] == "a" &&
            fileSuffixBytes[3] == "."
        ) {
            // Extract everything after "lda." by creating new bytes array
            bytes memory remainingBytes = new bytes(
                fileSuffixBytes.length - 4
            );
            for (uint256 i = 4; i < fileSuffixBytes.length; i++) {
                remainingBytes[i - 4] = fileSuffixBytes[i];
            }
            regularFileSuffix = string(remainingBytes);
        } else {
            // If no "lda." prefix, use as is
            regularFileSuffix = fileSuffix;
        }

        return
            string.concat(
                root,
                "/deployments/",
                network,
                ".",
                regularFileSuffix,
                "json"
            );
    }

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        emit log("=== STARTING UpdateLDACoreFacets ===");

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

        // For zkSync, read core facets from the zkSync deployment file (same as regular UpdateCoreFacets)
        emit log_named_string(
            "Reading core facets from zkSync deployment file",
            path
        );

        bytes4[] memory exclude;
        // Check if the LDA loupe was already added to the diamond
        bool loupeExists;

        emit log("=== CHECKING IF LOUPE EXISTS ===");
        try loupe.facetAddresses() returns (address[] memory existingFacets) {
            // If call was successful, loupe exists on LDA diamond already
            emit log("DiamondLoupeFacet exists on diamond already");
            emit log_uint(existingFacets.length);
            loupeExists = true;
        } catch Error(string memory reason) {
            emit log("DiamondLoupeFacet check failed with reason:");
            emit log(reason);
        } catch (bytes memory lowLevelData) {
            emit log("DiamondLoupeFacet check failed with low level data:");
            emit log_bytes(lowLevelData);
        }

        // Handle DiamondLoupeFacet separately as it needs special treatment
        if (!loupeExists) {
            emit log("=== ADDING DIAMONDLOUPE FACET ===");
            emit log("DiamondLoupeFacet does not exist on diamond yet");
            // Read DiamondLoupeFacet from zkSync deployment file (same as regular script)
            address ldaDiamondLoupeAddress = _getConfigContractAddress(
                path,
                ".DiamondLoupeFacet"
            );
            emit log_named_address(
                "DiamondLoupeFacet address",
                ldaDiamondLoupeAddress
            );

            bytes4[] memory loupeSelectors = getSelectors(
                "DiamondLoupeFacet",
                exclude
            );
            emit log("DiamondLoupeFacet selectors:");
            for (uint256 i = 0; i < loupeSelectors.length; i++) {
                emit log_bytes32(loupeSelectors[i]);
            }

            buildInitialCut(loupeSelectors, ldaDiamondLoupeAddress);
            emit log("=== EXECUTING DIAMONDCUT FOR LOUPE ===");
            vm.startBroadcast(deployerPrivateKey);
            if (cut.length > 0) {
                cutter.diamondCut(cut, address(0), "");
            }
            vm.stopBroadcast();
            emit log("=== DIAMONDCUT FOR LOUPE COMPLETED ===");

            // Reset diamond cut variable to remove LDA diamondLoupe information
            delete cut;
        }

        emit log("=== PROCESSING OTHER CORE FACETS ===");
        // Process all LDA core facets dynamically
        for (uint256 i = 0; i < ldaCoreFacets.length; i++) {
            string memory facetName = ldaCoreFacets[i];

            // Skip DiamondCutFacet and DiamondLoupeFacet as they were already handled
            if (
                keccak256(bytes(facetName)) ==
                keccak256(bytes("DiamondLoupeFacet"))
            ) {
                emit log("Skipping DiamondLoupeFacet");
                continue;
            }
            // Skip DiamondCutFacet as it was already handled during LDA diamond deployment
            if (
                keccak256(bytes(facetName)) ==
                keccak256(bytes("DiamondCutFacet"))
            ) {
                emit log("Skipping DiamondCutFacet");
                continue;
            }

            emit log("Now adding LDA core facet: ");
            emit log(facetName);
            // Read core facets from zkSync deployment file (same as regular script)
            address facetAddress = _getConfigContractAddress(
                path,
                string.concat(".", facetName)
            );
            emit log_named_address("Facet address", facetAddress);

            bytes4[] memory selectors = getSelectors(facetName, exclude);
            emit log("Facet selectors:");
            for (uint256 j = 0; j < selectors.length; j++) {
                emit log_bytes32(selectors[j]);
            }

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

        emit log("=== EXECUTING FINAL DIAMONDCUT ===");
        vm.startBroadcast(deployerPrivateKey);
        if (cut.length > 0) {
            cutter.diamondCut(cut, address(0), "");
        }
        vm.stopBroadcast();
        emit log("=== FINAL DIAMONDCUT COMPLETED ===");

        facets = loupe.facetAddresses();
        emit log("=== UpdateLDACoreFacets COMPLETED ===");
    }
}
