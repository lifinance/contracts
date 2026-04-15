// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LayerSwapFacet } from "lifi/Facets/LayerSwapFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("LayerSwapFacet") {}

    function run()
        public
        returns (LayerSwapFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = LayerSwapFacet(deploy(type(LayerSwapFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory layerSwapPath = string.concat(
            root,
            "/config/layer-swap.json"
        );
        address layerSwapDepository = _getConfigContractAddress(
            layerSwapPath,
            string.concat(".", network, ".layerSwapDepository")
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

        return abi.encode(layerSwapDepository, backendSigner);
    }
}
