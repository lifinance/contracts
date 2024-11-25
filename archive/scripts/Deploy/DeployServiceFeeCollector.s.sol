// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { ServiceFeeCollector } from "lifi/Periphery/ServiceFeeCollector.sol";
import { stdJson } from "forge-std/Script.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("ServiceFeeCollector") {}

    function run()
        public
        returns (ServiceFeeCollector deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = ServiceFeeCollector(
            deploy(type(ServiceFeeCollector).creationCode)
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
        address withdrawWalletAddress = globalConfigJson.readAddress(
            ".withdrawWallet"
        );

        return abi.encode(withdrawWalletAddress);
    }
}
