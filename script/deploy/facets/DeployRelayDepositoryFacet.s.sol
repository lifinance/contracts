// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { RelayDepositoryFacet } from "lifi/Facets/RelayDepositoryFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("RelayDepositoryFacet") {}

    function run()
        public
        returns (RelayDepositoryFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = RelayDepositoryFacet(
            deploy(type(RelayDepositoryFacet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/relay.json");

        address relayDepository = _getConfigContractAddress(
            path,
            string.concat(".", network, ".relayDepository")
        );

        return abi.encode(relayDepository);
    }
}
