// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { AcrossFacet } from "lifi/Facets/AcrossFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("AcrossFacet") {}

    function run() public returns (AcrossFacet deployed) {
        string memory path = string.concat(vm.projectRoot(), "/config/across.json");
        string memory json = vm.readFile(path);
        address acrossSpokePool = json.readAddress(string.concat(".", network, ".acrossSpokePool"));
        address weth = json.readAddress(string.concat(".", network, ".weth"));

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return AcrossFacet(payable(predicted));
        }

        deployed = AcrossFacet(
            payable(
                factory.deploy(salt, bytes.concat(type(AcrossFacet).creationCode, abi.encode(acrossSpokePool, weth)))
            )
        );

        vm.stopBroadcast();
    }
}
