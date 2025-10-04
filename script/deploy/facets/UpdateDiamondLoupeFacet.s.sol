// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";

contract DeployScript is UpdateScriptBase {
    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        // Check if the loupe was already added to the diamond
        bool loupeExists;
        try loupe.facetAddresses() returns (address[] memory) {
            // If call was successful, loupe exists on diamond already
            emit log("Loupe exists on diamond already");
            loupeExists = true;
        } catch {
            // No need to do anything, just making sure that the flow continues in both cases with try/catch
        }

        // Handle DiamondLoupeFacet separately as it needs special treatment
        if (!loupeExists) {
            emit log("Loupe does not exist on diamond yet");
            address diamondLoupeAddress = _getConfigContractAddress(
                path,
                ".DiamondLoupeFacet"
            );
            bytes4[] memory exclude;
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

        // Prepare full diamondCut calldata and log for debugging purposes
        if (cut.length > 0) {
            cutData = abi.encodeWithSelector(
                DiamondCutFacet.diamondCut.selector,
                cut,
                address(0),
                ""
            );

            emit log("DiamondCutCalldata: ");
            emit log_bytes(cutData);
        }

        if (noBroadcast) {
            return (facets, cutData);
        }

        // Return facets if loupe exists, otherwise return empty array
        if (loupeExists) {
            facets = loupe.facetAddresses();
        } else {
            // Return empty facets array since we can't query facets yet
            // The DiamondLoupeFacet will be available after this deployment
            facets = new address[](0);
        }
    }
}
