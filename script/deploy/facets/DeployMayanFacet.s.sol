// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { MayanFacet } from "lifi/Facets/MayanFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("MayanFacet") {}

    function run()
        public
        returns (MayanFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = MayanFacet(deploy(type(MayanFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/mayan.json");

        address bridge = _getConfigContractAddress(
            path,
            string.concat(".bridges.", network, ".bridge")
        );

        return abi.encode(bridge);
    }
}
