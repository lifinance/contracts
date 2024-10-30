// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { RelayFacet } from "lifi/Facets/RelayFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("RelayFacet") {}

    function run()
        public
        returns (RelayFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = RelayFacet(deploy(type(RelayFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        // If you don't have a constructor or it doesn't take any arguments, you can remove this function
        string memory path = string.concat(root, "/config/relay.json");
        string memory json = vm.readFile(path);

        address relayReceiver = json.readAddress(
            string.concat(".", network, ".relayReceiver")
        );

        address relaySolver = json.readAddress(
            string.concat(".", network, ".relaySolver")
        );

        return abi.encode(relayReceiver, relaySolver);
    }
}
