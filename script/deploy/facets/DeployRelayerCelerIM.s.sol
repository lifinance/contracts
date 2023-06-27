// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { RelayerCelerIM } from "lifi/Periphery/RelayerCelerIM.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    string internal globalConfigPath;
    string internal globalConfigJson;

    constructor() DeployScriptBase("RelayerCelerIM") {}

    function run()
        public
        returns (RelayerCelerIM deployed, bytes memory constructorArgs)
    {
        // get path of global config file
        globalConfigPath = string.concat(root, "/config/global.json");

        // read file into json variable
        globalConfigJson = vm.readFile(globalConfigPath);

        // extract refundWallet address
        address refundWalletAddress = globalConfigJson.readAddress(
            ".refundWallet"
        );

        string memory path = string.concat(
            vm.projectRoot(),
            "/config/cbridge.json"
        );
        string memory json = vm.readFile(path);
        address messageBus = json.readAddress(
            string.concat(".", network, ".messageBus")
        );

        path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );
        json = vm.readFile(path);
        address diamond = json.readAddress(".LiFiDiamond");

        constructorArgs = abi.encode(refundWalletAddress, messageBus, diamond);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (RelayerCelerIM(payable(predicted)), constructorArgs);
        }

        deployed = RelayerCelerIM(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(RelayerCelerIM).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
