// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { GnosisBridgeFacet } from "lifi/Facets/GnosisBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("GnosisBridgeFacet") {}

    function run()
        public
        returns (GnosisBridgeFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = GnosisBridgeFacet(
            deploy(type(GnosisBridgeFacet).creationCode)
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
