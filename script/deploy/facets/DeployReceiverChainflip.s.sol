// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { ReceiverChainflip } from "lifi/Periphery/ReceiverChainflip.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("ReceiverChainflip") {}

    function run()
        public
        returns (ReceiverChainflip deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = ReceiverChainflip(
            deploy(type(ReceiverChainflip).creationCode)
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

        // obtain address of Chainflip vault in current network from config file
        string memory path = string.concat(root, "/config/chainflip.json");

        address chainflipVault = _getConfigContractAddress(
            path,
            string.concat(".chainflipVault.", network)
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
        address executor = _getConfigContractAddress(path, ".Executor");

        return abi.encode(refundWalletAddress, executor, chainflipVault);
    }
}
