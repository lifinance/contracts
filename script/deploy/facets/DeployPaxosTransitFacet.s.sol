// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { PaxosTransitFacet } from "lifi/Facets/PaxosTransitFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("PaxosTransitFacet") {}

    function run()
        public
        returns (PaxosTransitFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = PaxosTransitFacet(
            deploy(type(PaxosTransitFacet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/paxosTransit.json");

        address transitStation = _getConfigContractAddress(
            path,
            string.concat(".transitStation.", network)
        );

        return abi.encode(transitStation);
    }
}
