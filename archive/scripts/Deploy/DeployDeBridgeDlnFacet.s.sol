// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { DeBridgeDlnFacet } from "lifi/Facets/DeBridgeDlnFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("DeBridgeDlnFacet") {}

    function run()
        public
        returns (DeBridgeDlnFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = DeBridgeDlnFacet(
            deploy(type(DeBridgeDlnFacet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/dln.json");
        string memory json = vm.readFile(path);

        address dlnSource = json.readAddress(
            string.concat(".", network, ".dlnSource")
        );

        return abi.encode(dlnSource);
    }
}
