// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { OutputValidator } from "lifi/Periphery/OutputValidator.sol";
import { stdJson } from "forge-std/Script.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("OutputValidator") {}

    function run()
        public
        returns (OutputValidator deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = OutputValidator(deploy(type(OutputValidator).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        // get path of global config file
        string memory globalConfigPath = string.concat(
            root,
            "/config/global.json"
        );

        // read file into json variable
        string memory globalConfigJson = vm.readFile(globalConfigPath);

        // extract refundWallet address from global config
        address outputValidatorOwnerAddress = globalConfigJson.readAddress(
            ".refundWallet"
        );

        return abi.encode(outputValidatorOwnerAddress);
    }
}
