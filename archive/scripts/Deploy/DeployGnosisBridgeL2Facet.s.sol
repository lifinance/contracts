// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { GnosisBridgeL2Facet } from "lifi/Facets/GnosisBridgeL2Facet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("GnosisBridgeL2Facet") {}

    function run()
        public
        returns (GnosisBridgeL2Facet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = GnosisBridgeL2Facet(
            deploy(type(GnosisBridgeL2Facet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/gnosis.json");
        string memory json = vm.readFile(path);

        address xDaiBridge = json.readAddress(
            string.concat(".", network, ".xDaiBridge")
        );

        return abi.encode(xDaiBridge);
    }
}
