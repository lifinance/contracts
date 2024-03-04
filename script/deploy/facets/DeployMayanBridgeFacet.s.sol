// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { MayanBridgeFacet } from "lifi/Facets/MayanBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("MayanBridgeFacet") {}

    function run()
        public
        returns (MayanBridgeFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = MayanBridgeFacet(
            deploy(type(MayanBridgeFacet).creationCode)
        );
    }

    // function getConstructorArgs() internal override returns (bytes memory) {
    //     // If you don't have a constructor or it doesn't take any arguments, you can remove this function
    //     string memory path = string.concat(root, "/config/mayanBridge.json");
    //     string memory json = vm.readFile(path);
    //
    //     address acrossSpokePool = json.readAddress(
    //         string.concat(".", network, ".example")
    //     );
    //
    //     return abi.encode(example);
    // }
}
