// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { GasZipPeriphery } from "lifi/Periphery/GasZipPeriphery.sol";
import { stdJson } from "forge-std/Script.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("GasZipPeriphery") {}

    function run()
        public
        returns (GasZipPeriphery deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = GasZipPeriphery(deploy(type(GasZipPeriphery).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        // get gasZipRouter address
        string memory path = string.concat(root, "/config/gaszip.json");

        address gasZipRouter = _getConfigContractAddress(
            path,
            string.concat(".gasZipRouters.", network)
        );

        // get LiFiDEXAggregator address
        path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );

        address liFiDEXAggregator = _getConfigContractAddress(
            path,
            ".LiFiDEXAggregator"
        );

        // get network's SAFE address to become contract owner for potential fund withdrawals
        path = string.concat(root, "/config/networks.json");

        address safeAddress = _getConfigContractAddress(
            path,
            string.concat(".", network, ".safeAddress")
        );

        return abi.encode(gasZipRouter, liFiDEXAggregator, safeAddress);
    }
}
