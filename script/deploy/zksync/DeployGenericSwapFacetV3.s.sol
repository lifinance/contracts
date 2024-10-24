// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { GenericSwapFacetV3 } from "lifi/Facets/GenericSwapFacetV3.sol";
import { stdJson } from "forge-std/Script.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("GenericSwapFacetV3") {}

    function run()
        public
        returns (GenericSwapFacetV3 deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = GenericSwapFacetV3(
            deploy(type(GenericSwapFacetV3).creationCode)
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

        // extract network's native address
        address nativeAddress = globalConfigJson.readAddress(
            string.concat(".nativeAddress.", network)
        );

        return abi.encode(nativeAddress);
    }
}
