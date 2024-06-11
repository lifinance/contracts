// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { AmarokFacetPacked } from "lifi/Facets/AmarokFacetPacked.sol";
import { stdJson } from "forge-std/StdJson.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("AmarokFacetPacked") {}

    function run()
        public
        returns (AmarokFacetPacked deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = AmarokFacetPacked(
            deploy(type(AmarokFacetPacked).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/amarok.json");
        string memory json = vm.readFile(path);

        address connextHandler = json.readAddress(
            string.concat(".", network, ".connextHandler")
        );

        return abi.encode(connextHandler, deployerAddress);
    }
}
