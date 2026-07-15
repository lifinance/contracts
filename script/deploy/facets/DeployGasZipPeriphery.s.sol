// SPDX-License-Identifier: LGPL-3.0-only
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

        // get LiFiDiamond address
        path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );

        address liFiDiamond = _getConfigContractAddress(path, ".LiFiDiamond");

        // refundWallet becomes contract owner for potential fund withdrawals
        string memory globalConfigPath = string.concat(
            root,
            "/config/global.json"
        );

        string memory globalConfigJson = vm.readFile(globalConfigPath);

        address refundWalletAddress = globalConfigJson.readAddress(
            ".refundWallet"
        );

        return abi.encode(gasZipRouter, liFiDiamond, refundWalletAddress);
    }
}
