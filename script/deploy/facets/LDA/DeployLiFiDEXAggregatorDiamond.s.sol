// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "../utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LiFiDEXAggregatorDiamond } from "lifi/Periphery/LDA/LiFiDEXAggregatorDiamond.sol";

contract DeployScript is DeployScriptBase {
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
        // LDA Diamond uses DiamondCutFacet from regular deployment (shared with regular LiFi Diamond)
        // Construct path to regular deployment file: <network>.json or <network>.<environment>.json

        string memory regularPath;

        // Check if fileSuffix is provided (non-production environment)
        if (bytes(fileSuffix).length > 0) {
            // Non-production: network.<environment>.json (e.g., network.staging.json, network.testnet.json)
            regularPath = string.concat(
                root,
                "/deployments/",
                network,
                ".",
                fileSuffix,
                "json"
            );
        } else {
            // Production: network.json
            regularPath = string.concat(
                root,
                "/deployments/",
                network,
                ".json"
            );
        }

        emit log_named_string("regularPath", regularPath);

        // Get DiamondCutFacet address from regular deployment file
        address diamondCut = _getConfigContractAddress(
            regularPath,
            ".DiamondCutFacet"
        );

        emit log_named_address("diamondCut", diamondCut);

        return abi.encode(deployerAddress, diamondCut);
    }
}
