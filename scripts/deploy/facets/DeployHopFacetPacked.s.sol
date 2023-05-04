// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { HopFacetPacked } from "lifi/Facets/HopFacetPacked.sol";
import { stdJson } from "forge-std/StdJson.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    string internal json;
    string internal path;

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
        path = string.concat(root, "/config/hop.json");
        json = vm.readFile(path);
        bytes memory rawConfig = json.parseRaw(
            string.concat(".", network, ".tokens")
        );
        Config[] memory configs = abi.decode(rawConfig, (Config[]));

        address ammWrapper;
        for (uint256 i = 0; i < configs.length; i++) {
            if (
                keccak256(abi.encodePacked(configs[i].name)) ==
                keccak256(abi.encodePacked("ETH"))
            ) {
                ammWrapper = configs[i].ammWrapper;
            }
        }

        vm.startBroadcast(deployerPrivateKey);

        constructorArgs = abi.encode(deployerAddress, ammWrapper);

        if (isDeployed()) {
            return (HopFacetPacked(predicted), constructorArgs);
        }

        deployed = HopFacetPacked(
            factory.deploy(
                salt,
                bytes.concat(
                    type(HopFacetPacked).creationCode,
                    constructorArgs
                )
            )
        );

        vm.stopBroadcast();
    }
}
