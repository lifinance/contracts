// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployLDAScriptBase } from "./utils/DeployLDAScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LDAEmergencyPauseFacet } from "lifi/Periphery/LDA/Facets/LDAEmergencyPauseFacet.sol";

contract DeployScript is DeployLDAScriptBase {
    using stdJson for string;

    constructor() DeployLDAScriptBase("LDAEmergencyPauseFacet") {}

    function run()
        public
        returns (LDAEmergencyPauseFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = LDAEmergencyPauseFacet(
            deploy(type(LDAEmergencyPauseFacet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/global.json");
        string memory json = vm.readFile(path);

        address pauserWallet = json.readAddress(".pauserWallet");

        return abi.encode(pauserWallet);
    }
}
