// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { AllBridgeFacet } from "lifi/Facets/AllBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("AllBridgeFacet") {}

    function run()
        public
        returns (AllBridgeFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = AllBridgeFacet(deploy(type(AllBridgeFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/allbridge.json");
        string memory json = vm.readFile(path);

        address allBridge = json.readAddress(
            string.concat(".", network, ".allBridge")
        );

        return abi.encode(allBridge);
    }
}
