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
        string memory gasZipConfig = string.concat(
            root,
            "/config/gaszip.json"
        );

        string memory gasZipConfigJson = vm.readFile(gasZipConfig);

        address gasZipRouter = gasZipConfigJson.readAddress(
            string.concat(".gasZipRouters.", network)
        );

        // get LiFiDEXAggregator address
        string memory deployLog = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );
        string memory json = vm.readFile(deployLog);

        address liFiDEXAggregator = json.readAddress(".LiFiDEXAggregator");

        // get network's SAFE address to become contract owner for potential fund withdrawals
        string memory networks = string.concat(root, "/config/networks.json");

        string memory networksJson = vm.readFile(networks);

        address safeAddress = networksJson.readAddress(
            string.concat(".", network, ".safeAddress")
        );

        return abi.encode(gasZipRouter, liFiDEXAggregator, safeAddress);
    }
}
