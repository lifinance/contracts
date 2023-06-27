// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase, console } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { Receiver } from "lifi/Periphery/Receiver.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("Receiver") {}

    string internal globalConfigPath;
    string internal globalConfigJson;

    function run()
        public
        returns (Receiver deployed, bytes memory constructorArgs)
    {
        // get path of global config file
        globalConfigPath = string.concat(root, "/config/global.json");

        // read file into json variable
        globalConfigJson = vm.readFile(globalConfigPath);

        // extract refundWallet address
        address refundWalletAddress = globalConfigJson.readAddress(
            ".refundWallet"
        );

        // obtain address of Stargate router in current network from config file
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/stargate.json"
        );
        string memory json = vm.readFile(path);
        address stargateRouter = json.readAddress(
            string.concat(".routers.", network)
        );

        // obtain address of Amarok router in current network from config file
        path = string.concat(vm.projectRoot(), "/config/amarok.json");
        json = vm.readFile(path);
        address amarokRouter = json.readAddress(
            string.concat(".", network, ".connextHandler")
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
        address executor = json.readAddress(".Executor");

        constructorArgs = abi.encode(
            refundWalletAddress,
            stargateRouter,
            amarokRouter,
            executor,
            100000
        );

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (Receiver(payable(predicted)), constructorArgs);
        }

        deployed = Receiver(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(type(Receiver).creationCode, constructorArgs)
                )
            )
        );

        vm.stopBroadcast();
    }
}
