// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { AcrossFacetPackedV3 } from "lifi/Facets/AcrossFacetPackedV3.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("AcrossFacetPackedV3") {}

    function run()
        public
        returns (AcrossFacetPackedV3 deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = AcrossFacetPackedV3(
            deploy(type(AcrossFacetPackedV3).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/across.json");

        address acrossSpokePool = _getConfigContractAddress(
            path,
            string.concat(".", network, ".acrossSpokePool")
        );
        address weth = _getConfigContractAddress(
            path,
            string.concat(".", network, ".weth")
        );

        return abi.encode(acrossSpokePool, weth, deployerAddress);
    }
}
