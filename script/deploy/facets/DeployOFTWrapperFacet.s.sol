// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { OFTWrapperFacet } from "lifi/Facets/OFTWrapperFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("OFTWrapperFacet") {}

    function run()
        public
        returns (OFTWrapperFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = OFTWrapperFacet(deploy(type(OFTWrapperFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/oftwrapper.json");
        string memory json = vm.readFile(path);

        address oftWrapper = json.readAddress(
            string.concat(".wrappers.", network)
        );

        return abi.encode(oftWrapper);
    }
}
