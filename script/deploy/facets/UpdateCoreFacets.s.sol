// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    error FailedToReadCoreFacetsFromConfig();
    error DiamondLoupeFacetNotFound();

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

        // DiamondLoupeFacet should already be deployed by UpdateDiamondLoupeFacet.s.sol
        // Verify it exists, if not, this script will fail
        try loupe.facetAddresses() returns (address[] memory) {
            emit log(
                "DiamondLoupeFacet exists - proceeding with core facets deployment"
            );
        } catch {
            revert DiamondLoupeFacetNotFound();
        }

        // Process all core facets dynamically
        for (uint256 i = 0; i < coreFacets.length; i++) {
            string memory facetName = coreFacets[i];

            // Skip DiamondCutFacet and DiamondLoupeFacet as they are handled separately
            if (
                keccak256(bytes(facetName)) ==
                keccak256(bytes("DiamondLoupeFacet"))
            ) {
                continue;
            }
            if (
                keccak256(bytes(facetName)) ==
                keccak256(bytes("DiamondCutFacet"))
            ) {
                continue;
            }

            emit log("Now adding facet: ");
            emit log(facetName);
            // Use _getConfigContractAddress which validates the contract exists
            address facetAddress = _getConfigContractAddress(
                path,
                string.concat(".", facetName)
            );
            bytes4[] memory selectors = getSelectors(facetName, exclude);

            // at this point we know for sure that diamond loupe exists on diamond
            buildDiamondCut(selectors, facetAddress);
            // if (loupeExists) {
            //     buildDiamondCut(selectors, facetAddress);
            // } else {
            //     buildInitialCut(selectors, facetAddress);
            // }
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
