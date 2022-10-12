// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { StargateFacet } from "lifi/Facets/StargateFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("StargateFacet") {}

    function run() public returns (StargateFacet deployed) {
        string memory path = string.concat(vm.projectRoot(), "/config/stargate.json");
        string memory json = vm.readFile(path);
        address stargateRouter = json.readAddress(string.concat(".config.", network, ".stargateRouter"));

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return StargateFacet(payable(predicted));
        }

        deployed = StargateFacet(
            payable(factory.deploy(salt, bytes.concat(type(StargateFacet).creationCode, abi.encode(stargateRouter))))
        );

        vm.stopBroadcast();
    }
}
