// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { CCTPFacet } from "lifi/Facets/CCTPFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("CCTPFacet") { }

    function run()
        public
        returns (CCTPFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = CCTPFacet(deploy(type(CCTPFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/cctp.json");

        address tokenMessenger = _getConfigContractAddress(
            path, string.concat(".", network, ".tokenMessengerV2")
        );

        address usdc = _getConfigContractAddress(
            path, string.concat(".", network, ".usdc")
        );

        return abi.encode(tokenMessenger, usdc);
    }
}
