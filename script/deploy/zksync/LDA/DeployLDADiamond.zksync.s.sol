// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployLDAScriptBase } from "./utils/DeployLDAScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LDADiamond } from "lifi/Periphery/LDA/LDADiamond.sol";

contract DeployScript is DeployLDAScriptBase {
    using stdJson for string;

    constructor() DeployLDAScriptBase("LDADiamond") {}

    function run()
        public
        returns (LDADiamond deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();
        deployed = LDADiamond(deploy(type(LDADiamond).creationCode));
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
