// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { LidoWrapper } from "lifi/Periphery/LidoWrapper.sol";
import { stdJson } from "forge-std/Script.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("LidoWrapper") {}

    function run()
        public
        returns (LidoWrapper deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = LidoWrapper(deploy(type(LidoWrapper).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        // get path of lidowrapper config
        string memory path = string.concat(root, "/config/lidowrapper.json");

        // extract stETH and wstWETH token addresses for the given network
        address stETHAddress = _getConfigContractAddress(
            path,
            string.concat(".", network, ".stETH")
        );
        address wstETHAddress = _getConfigContractAddress(
            path,
            string.concat(".", network, ".wstETH")
        );

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

        return abi.encode(stETHAddress, wstETHAddress, refundWalletAddress);
    }
}
