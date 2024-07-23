// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { EmergencyPauseFacet } from "lifi/Facets/EmergencyPauseFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("EmergencyPauseFacet") {}

    function run()
        public
        returns (EmergencyPauseFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = EmergencyPauseFacet(
            deploy(type(EmergencyPauseFacet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/global.json");
        string memory json = vm.readFile(path);

        address pauserWallet = json.readAddress(".pauserWallet");

        return abi.encode(pauserWallet);
    }
}
