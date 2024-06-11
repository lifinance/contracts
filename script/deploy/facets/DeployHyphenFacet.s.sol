// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { HyphenFacet } from "lifi/Facets/HyphenFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("HyphenFacet") {}

    function run()
        public
        returns (HyphenFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = HyphenFacet(deploy(type(HyphenFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/hyphen.json");
        string memory json = vm.readFile(path);

        address hyphenRouter = json.readAddress(
            string.concat(".", network, ".hyphenRouter")
        );

        return abi.encode(hyphenRouter);
    }
}
