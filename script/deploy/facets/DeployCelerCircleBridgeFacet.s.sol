// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { CelerCircleBridgeFacet } from "lifi/Facets/CelerCircleBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("CelerCircleBridgeFacet") {}

    function run()
        public
        returns (CelerCircleBridgeFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = CelerCircleBridgeFacet(
            deploy(type(CelerCircleBridgeFacet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/celerCircle.json");
        string memory json = vm.readFile(path);

        address circleBridgeProxy = json.readAddress(
            string.concat(".", network, ".circleBridgeProxy")
        );
        address usdc = json.readAddress(string.concat(".", network, ".usdc"));

        return abi.encode(circleBridgeProxy, usdc);
    }
}
