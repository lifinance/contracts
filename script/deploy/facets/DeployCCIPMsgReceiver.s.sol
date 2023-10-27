// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { CCIPMsgReceiver } from "lifi/Periphery/CCIPMsgReceiver.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("CCIPMsgReceiver") {}

    function run()
        public
        returns (CCIPMsgReceiver deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = CCIPMsgReceiver(deploy(type(CCIPMsgReceiver).creationCode));
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
        string memory path = string.concat(root, "/config/ccip.json");
        string memory json = vm.readFile(path);

        address ccipRouter = json.readAddress(
            string.concat(".routers.", network, ".router")
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

        return abi.encode(refundWalletAddress, ccipRouter, executor, 100000);
    }
}
