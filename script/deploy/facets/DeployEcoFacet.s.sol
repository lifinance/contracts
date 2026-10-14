// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { EcoFacet } from "lifi/Facets/EcoFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("EcoFacet") {}

    function run()
        public
        returns (EcoFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = EcoFacet(deploy(type(EcoFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/eco.json");

        address portal = _getConfigContractAddress(
            path,
            string.concat(".", network, ".portal")
        );

        string memory globalPath = string.concat(root, "/config/global.json");
        string memory globalJson = vm.readFile(globalPath);

        address backendSigner;
        if (
            keccak256(abi.encodePacked(fileSuffix)) ==
            keccak256(abi.encodePacked("staging."))
        ) {
            backendSigner = globalJson.readAddress(".backendSigner.staging");
        } else {
            backendSigner = globalJson.readAddress(
                ".backendSigner.production"
            );
        }

        return abi.encode(portal, backendSigner);
    }
}
