// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { HopFacetPacked } from "lifi/Facets/HopFacetPacked.sol";
import { stdJson } from "forge-std/StdJson.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    struct Config {
        address ammWrapper;
        address bridge;
        string name;
        address token;
    }

    constructor() DeployScriptBase("HopFacetPacked") {}

    function run()
        public
        returns (HopFacetPacked deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = HopFacetPacked(deploy(type(HopFacetPacked).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/hop.json");
        string memory json = vm.readFile(path);

        bytes memory rawConfig = json.parseRaw(
            string.concat(".", network, ".tokens")
        );
        Config[] memory configs = abi.decode(rawConfig, (Config[]));

        // Find the ammWrapper address for the native token on this chain
        address ammWrapper;
        for (uint256 i = 0; i < configs.length; i++) {
            if (
                configs[i].token == 0x0000000000000000000000000000000000000000
            ) {
                ammWrapper = configs[i].ammWrapper;
            }
        }

        return abi.encode(deployerAddress, ammWrapper);
    }
}
