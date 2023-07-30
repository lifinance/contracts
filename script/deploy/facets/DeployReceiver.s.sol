// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { Receiver } from "lifi/Periphery/Receiver.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("Receiver") {}

    function run()
        public
        returns (Receiver deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = Receiver(deploy(type(Receiver).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        // get path of global config file
        string memory globalConfigPath = string.concat(
            root,
            "/config/global.json"
        );

        // read file into json variable
        string memory globalConfigJson = vm.readFile(globalConfigPath);

        // extract refundWallet address
        address refundWalletAddress = globalConfigJson.readAddress(
            ".refundWallet"
        );

        // obtain address of Stargate router in current network from config file
        string memory path = string.concat(root, "/config/stargate.json");
        string memory json = vm.readFile(path);

        address stargateRouter = json.readAddress(
            string.concat(".routers.", network)
        );

        // obtain address of Amarok router in current network from config file
        path = string.concat(root, "/config/amarok.json");
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

        return
            abi.encode(
                refundWalletAddress,
                stargateRouter,
                amarokRouter,
                executor,
                100000
            );
    }
}
