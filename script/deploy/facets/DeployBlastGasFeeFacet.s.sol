// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { BlastGasFeeFacet } from "lifi/Facets/BlastGasFeeFacet.sol";
import { stdJson } from "forge-std/Script.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("BlastGasFeeFacet") {}

    function run()
        public
        returns (BlastGasFeeFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = BlastGasFeeFacet(
            deploy(type(BlastGasFeeFacet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory globalConfigPath = string.concat(
            root,
            "/config/global.json"
        );
        string memory globalConfigJson = vm.readFile(globalConfigPath);

        address withdrawWallet = globalConfigJson.readAddress(
            ".withdrawWallet"
        );

        return abi.encode(withdrawWallet);
    }
}
