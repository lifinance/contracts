// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { AxelarFacet } from "lifi/Facets/AxelarFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("AxelarFacet") {}

    function run() public returns (AxelarFacet deployed) {
        string memory path = string.concat(vm.projectRoot(), "/config/axelar.json");
        string memory json = vm.readFile(path);
        address gateway = json.readAddress(string.concat(".", network, ".gateway"));
        address gasService = json.readAddress(string.concat(".", network, ".gasService"));

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return AxelarFacet(payable(predicted));
        }

        deployed = AxelarFacet(
            payable(factory.deploy(salt, bytes.concat(type(AxelarFacet).creationCode, abi.encode(gateway, gasService))))
        );

        vm.stopBroadcast();
    }
}
