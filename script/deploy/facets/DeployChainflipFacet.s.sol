// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { ChainflipFacet } from "lifi/Facets/ChainflipFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("ChainflipFacet") {}

    function run()
        public
        returns (ChainflipFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = ChainflipFacet(deploy(type(ChainflipFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        // get path of chainflip config file
        string memory path = string.concat(root, "/config/chainflip.json");

        // Read the Chainflip vault address from config
        address chainflipVault = _getConfigContractAddress(
            path,
            string.concat(".", network, ".chainflipVault")
        );

        return abi.encode(chainflipVault);
    }
}
