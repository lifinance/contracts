// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { AcrossFacetV3 } from "lifi/Facets/AcrossFacetV3.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("AcrossFacetV3") {}

    function run()
        public
        returns (AcrossFacetV3 deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = AcrossFacetV3(deploy(type(AcrossFacetV3).creationCode));
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
