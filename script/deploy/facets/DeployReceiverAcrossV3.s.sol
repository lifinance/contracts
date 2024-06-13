// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { ReceiverAcrossV3 } from "lifi/Periphery/ReceiverAcrossV3.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("ReceiverAcrossV3") {}

    function run()
        public
        returns (ReceiverAcrossV3 deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = ReceiverAcrossV3(
            deploy(type(ReceiverAcrossV3).creationCode)
        );
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

        // obtain address of Across's Spokepool contract in current network from config file
        string memory path = string.concat(root, "/config/across.json");
        string memory json = vm.readFile(path);

        address spokePool = json.readAddress(
            string.concat(".", network, ".acrossSpokePool")
        );

        // get Executor address from deploy log
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

        return abi.encode(refundWalletAddress, executor, spokePool, 100000);
    }
}
