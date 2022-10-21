// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { PolygonBridgeFacet } from "lifi/Facets/PolygonBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("PolygonBridgeFacet") {}

    function run() public returns (PolygonBridgeFacet deployed, bytes memory constructorArgs) {
        string memory path = string.concat(vm.projectRoot(), "/config/polygon.json");
        string memory json = vm.readFile(path);
        address rootChainManager = json.readAddress(string.concat(".", network, ".rootChainManager"));
        address erc20Predicate = json.readAddress(string.concat(".", network, ".erc20Predicate"));

        constructorArgs = abi.encode(rootChainManager, erc20Predicate);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (PolygonBridgeFacet(payable(predicted)), constructorArgs);
        }

        deployed = PolygonBridgeFacet(
            payable(factory.deploy(salt, bytes.concat(type(PolygonBridgeFacet).creationCode, constructorArgs)))
        );

        vm.stopBroadcast();
    }
}
