// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { CelerCircleBridgeV2Facet } from "lifi/Facets/CelerCircleBridgeV2Facet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("CelerCircleBridgeV2Facet") {}

    function run()
        public
        returns (
            CelerCircleBridgeV2Facet deployed,
            bytes memory constructorArgs
        )
    {
        constructorArgs = getConstructorArgs();

        deployed = CelerCircleBridgeV2Facet(
            deploy(type(CelerCircleBridgeV2Facet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/celerCircleV2.json");

        address circleBridgeProxy = _getConfigContractAddress(
            path,
            string.concat(".", network, ".circleBridgeProxy")
        );

        address usdc = _getConfigContractAddress(
            path,
            string.concat(".", network, ".usdc")
        );

        return abi.encode(circleBridgeProxy, usdc);
    }
}
