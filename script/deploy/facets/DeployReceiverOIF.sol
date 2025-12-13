// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { ReceiverOIF } from "lifi/Periphery/ReceiverOIF.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("ReceiverOIF") {}

    function run()
        public
        returns (ReceiverOIF deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = ReceiverOIF(deploy(type(ReceiverOIF).creationCode));
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

        string memory path = string.concat(
            root,
            "/config/lifiintentescrow.json"
        );
        address outputSettler = _getConfigContractAddress(
            path,
            string.concat(".OIFOutputSettlerSimple")
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

        return abi.encode(refundWalletAddress, executor, outputSettler);
    }
}
