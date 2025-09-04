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
        // LDA Diamond uses DiamondCutFacet from regular deployment (shared with regular LiFi Diamond)
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

        string memory regularPath = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            regularFileSuffix,
            "json"
        );

        // Get DiamondCutFacet address from regular deployment file
        address diamondCut = _getConfigContractAddress(
            regularPath,
            ".DiamondCutFacet"
        );

        return abi.encode(deployerAddress, diamondCut);
    }
}
