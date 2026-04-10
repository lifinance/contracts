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
        string memory path = string.concat(
            root,
            "/config/layer-swap.json"
        );
        string memory json = vm.readFile(path);

        address layerSwapTarget = json.readAddress(
            string.concat(".", network, ".layerSwapTarget")
        );

        return abi.encode(layerSwapTarget);
    }
}
