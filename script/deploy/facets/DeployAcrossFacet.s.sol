// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

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
        string memory json = vm.readFile(path);

        address acrossSpokePool = json.readAddress(
            string.concat(".", network, ".acrossSpokePool")
        );
        address weth = json.readAddress(string.concat(".", network, ".weth"));

        return abi.encode(acrossSpokePool, weth);
    }
}
