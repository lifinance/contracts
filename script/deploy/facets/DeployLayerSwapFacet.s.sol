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
        string memory path = string.concat(root, "/config/layer-swap.json");
        string memory json = vm.readFile(path);

        address layerSwapDepository = _getConfigContractAddress(
            path,
            string.concat(".", network, ".layerSwapDepository")
        );

        address backendSigner;
        if (
            keccak256(abi.encodePacked(fileSuffix)) ==
            keccak256(abi.encodePacked("staging."))
        ) {
            backendSigner = json.readAddress(".staging.backendSigner");
        } else {
            backendSigner = json.readAddress(
                ".production.backendSigner"
            );
        }

        return abi.encode(layerSwapDepository, backendSigner);
    }
}
