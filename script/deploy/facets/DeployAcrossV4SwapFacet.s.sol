// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { AcrossV4SwapFacet } from "lifi/Facets/AcrossV4SwapFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("AcrossV4SwapFacet") {}

    function run()
        public
        returns (AcrossV4SwapFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = AcrossV4SwapFacet(
            deploy(type(AcrossV4SwapFacet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/acrossV4Swap.json");

        address spokePoolPeriphery = _getConfigContractAddress(
            path,
            string.concat(".", network, ".spokePoolPeriphery")
        );
        address spokePool = _getConfigContractAddress(
            path,
            string.concat(".", network, ".spokePool")
        );
        address sponsoredOftSrcPeriphery = _getConfigContractAddress(
            path,
            string.concat(".", network, ".sponsoredOftSrcPeriphery")
        );
        address sponsoredCctpSrcPeriphery = _getConfigContractAddress(
            path,
            string.concat(".", network, ".sponsoredCctpSrcPeriphery")
        );

        // check if production or staging
        string memory globalPath = string.concat(root, "/config/global.json");
        string memory globalJson = vm.readFile(globalPath);
        address backendSigner;
        if (
            keccak256(abi.encodePacked(fileSuffix)) ==
            keccak256(abi.encodePacked("staging."))
        ) {
            backendSigner = globalJson.readAddress(".backendSignerStaging");
        } else {
            backendSigner = globalJson.readAddress(".backendSignerProduction");
        }

        return
            abi.encode(
                spokePoolPeriphery,
                spokePool,
                sponsoredOftSrcPeriphery,
                sponsoredCctpSrcPeriphery,
                backendSigner
            );
    }
}
