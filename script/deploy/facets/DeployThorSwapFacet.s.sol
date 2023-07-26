// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { ThorSwapFacet } from "lifi/Facets/ThorSwapFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("ThorSwapFacet") {}

    function run()
        public
        returns (ThorSwapFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = ThorSwapFacet(deploy(type(ThorSwapFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/thorswap.json");
        string memory json = vm.readFile(path);

        address thorchainRouter = json.readAddress(
            string.concat(".", network, ".thorchainRouter")
        );

        return abi.encode(thorchainRouter);
    }
}
