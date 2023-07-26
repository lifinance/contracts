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
        constructorArgs = getConstructorArgs();

        deployed = RelayerCelerIM(deploy(type(RelayerCelerIM).creationCode));
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

        string memory path = string.concat(root, "/config/cbridge.json");
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

        return abi.encode(refundWalletAddress, messageBus, diamond);
    }
}
