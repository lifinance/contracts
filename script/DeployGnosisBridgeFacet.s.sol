// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { GnosisBridgeFacet } from "lifi/Facets/GnosisBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("GnosisBridgeFacet") {}

    function run() public returns (GnosisBridgeFacet deployed) {
        string memory path = string.concat(vm.projectRoot(), "/config/gnosis.json");
        string memory json = vm.readFile(path);
        address xDaiBridge = json.readAddress(string.concat(".", network, ".xDaiBridge"));

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return GnosisBridgeFacet(payable(predicted));
        }

        deployed = GnosisBridgeFacet(
            payable(factory.deploy(salt, bytes.concat(type(GnosisBridgeFacet).creationCode, abi.encode(xDaiBridge))))
        );

        vm.stopBroadcast();
    }
}
