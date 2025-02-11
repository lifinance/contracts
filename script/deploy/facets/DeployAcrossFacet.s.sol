// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { AcrossFacet } from "lifi/Facets/AcrossFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("AcrossFacet") {}

    function run()
        public
        returns (AcrossFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = AcrossFacet(deploy(type(AcrossFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/across.json");

        address acrossSpokePool = _getConfigContractAddress(
            path,
            string.concat(".", network, ".acrossSpokePool"),
            false
        );
        address weth = _getConfigContractAddress(
            path,
            string.concat(".", network, ".weth"),
            false
        );

        return abi.encode(acrossSpokePool, weth);
    }
}
