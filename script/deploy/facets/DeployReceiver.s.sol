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

        // obtain address of Stargate router in current network from config file (may be address(0), if stargate is not available on this chain)
        string memory path = string.concat(root, "/config/stargate.json");
        address stargateRouter = _getConfigContractAddress(
            path,
            string.concat(".composers.", network),
            true
        );

        // obtain address of Amarok router in current network from config file (may be address(0), if amarok is not available on this chain)
        path = string.concat(root, "/config/amarok.json");
        address amarokRouter = _getConfigContractAddress(
            path,
            string.concat(".", network, ".connextHandler"),
            true
        );

        path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );
        address executor = _getConfigContractAddress(path, ".Executor");

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
