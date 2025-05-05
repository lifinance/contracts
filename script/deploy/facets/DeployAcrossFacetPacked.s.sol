// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { AcrossFacetPacked } from "lifi/Facets/AcrossFacetPacked.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("AcrossFacetPacked") {}

    function run()
        public
        returns (AcrossFacetPacked deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = AcrossFacetPacked(
            deploy(type(AcrossFacetPacked).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory configPath = string.concat(root, "/config/across.json");
        string memory networksPath = string.concat(
            root,
            "/config/networks.json"
        );

        address acrossSpokePool = _getConfigContractAddress(
            configPath,
            string.concat(".", network, ".acrossSpokePool")
        );
        address wrappedNativeAddress = _getConfigContractAddress(
            networksPath,
            string.concat(".", network, ".wrappedNativeAddress")
        );

        return
            abi.encode(acrossSpokePool, wrappedNativeAddress, deployerAddress);
    }
}
