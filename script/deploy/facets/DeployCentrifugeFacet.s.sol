// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { CentrifugeFacet } from "lifi/Facets/CentrifugeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("CentrifugeFacet") {}

    function run()
        public
        returns (CentrifugeFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = CentrifugeFacet(
            deploy(type(CentrifugeFacet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(
            root,
            "/config/centrifuge.json"
        );
        string memory json = vm.readFile(path);

        address tokenBridge = _getConfigContractAddress(
            json,
            string.concat(".", network, ".tokenBridge")
        );

        return abi.encode(tokenBridge);
    }
}
