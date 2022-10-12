// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { HyphenFacet } from "lifi/Facets/HyphenFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("HyphenFacet") {}

    function run() public returns (HyphenFacet deployed) {
        string memory path = string.concat(vm.projectRoot(), "/config/hyphen.json");
        string memory json = vm.readFile(path);
        address hyphenRouter = json.readAddress(string.concat(".", network, ".hyphenRouter"));

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return HyphenFacet(payable(predicted));
        }

        deployed = HyphenFacet(
            payable(factory.deploy(salt, bytes.concat(type(HyphenFacet).creationCode, abi.encode(hyphenRouter))))
        );

        vm.stopBroadcast();
    }
}
