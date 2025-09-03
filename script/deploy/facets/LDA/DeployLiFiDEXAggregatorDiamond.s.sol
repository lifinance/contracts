// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployLDAScriptBase } from "./utils/DeployLDAScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LiFiDEXAggregatorDiamond } from "lifi/Periphery/LDA/LiFiDEXAggregatorDiamond.sol";

contract DeployScript is DeployLDAScriptBase {
    using stdJson for string;

    constructor() DeployLDAScriptBase("LiFiDEXAggregatorDiamond") {}

    function run()
        public
        returns (
            LiFiDEXAggregatorDiamond deployed,
            bytes memory constructorArgs
        )
    {
        constructorArgs = getConstructorArgs();
        deployed = LiFiDEXAggregatorDiamond(
            deploy(type(LiFiDEXAggregatorDiamond).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        // Build path to regular deployment file (not LDA-specific) to get DiamondCutFacet
        string memory regularFileSuffix = fileSuffix;
        
        // Remove "lda." prefix to get regular deployment file
        if (bytes(fileSuffix).length >= 4) {
            // Check if fileSuffix starts with "lda."
            bytes memory fileSuffixBytes = bytes(fileSuffix);
            bool hasLdaPrefix = (
                fileSuffixBytes[0] == 'l' &&
                fileSuffixBytes[1] == 'd' &&
                fileSuffixBytes[2] == 'a' &&
                fileSuffixBytes[3] == '.'
            );
            
            if (hasLdaPrefix) {
                // Remove "lda." prefix by creating new string without first 4 characters
                bytes memory newSuffix = new bytes(fileSuffixBytes.length - 4);
                for (uint256 i = 4; i < fileSuffixBytes.length; i++) {
                    newSuffix[i - 4] = fileSuffixBytes[i];
                }
                regularFileSuffix = string(newSuffix);
            }
        }
        
        string memory path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            regularFileSuffix,
            "json"
        );
        
        address diamondCut = _getConfigContractAddress(
            path,
            ".DiamondCutFacet"
        );

        return abi.encode(deployerAddress, diamondCut);
    }
}
