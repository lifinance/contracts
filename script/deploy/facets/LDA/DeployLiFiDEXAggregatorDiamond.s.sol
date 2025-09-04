// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployLDAScriptBase } from "./utils/DeployLDAScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LiFiDEXAggregatorDiamond } from "lifi/Periphery/LDA/LiFiDEXAggregatorDiamond.sol";

contract DeployScript is DeployLDAScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("LiFiDEXAggregatorDiamond") {}

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
        // Check if fileSuffix already contains "lda." to avoid double prefix
        string memory ldaPrefix = "";
        bytes memory fileSuffixBytes = bytes(fileSuffix);
        bool hasLdaPrefix = false;

        // Check if fileSuffix starts with "lda."
        if (fileSuffixBytes.length >= 4) {
            hasLdaPrefix = (fileSuffixBytes[0] == "l" &&
                fileSuffixBytes[1] == "d" &&
                fileSuffixBytes[2] == "a" &&
                fileSuffixBytes[3] == ".");
        }

        if (!hasLdaPrefix) {
            ldaPrefix = ".lda.";
        } else {
            ldaPrefix = ".";
        }

        string memory path = string.concat(
            root,
            "/deployments/",
            network,
            ldaPrefix,
            fileSuffix,
            "json"
        );
        address diamondCut = _getConfigContractAddress(
            path,
            ".LDADiamondCutFacet"
        );

        return abi.encode(deployerAddress, diamondCut);
    }
}
