// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { GasZipFacet } from "lifi/Facets/GasZipFacet.sol";
import { stdJson } from "forge-std/Script.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("GasZipFacet") {}

    function run()
        public
        returns (GasZipFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = GasZipFacet(deploy(type(GasZipFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory gasZipConfig = string.concat(
            root,
            "/config/gaszip.json"
        );

        string memory gasZipConfigJson = vm.readFile(gasZipConfig);

        address gasZipRouter = gasZipConfigJson.readAddress(
            string.concat(".gasZipRouters.", network)
        );

        return abi.encode(gasZipRouter);
    }
}
