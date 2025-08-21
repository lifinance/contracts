// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { EcoFacet } from "../../../src/Facets/EcoFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("EcoFacet") {}

    function run() public returns (address deployed) {
        string memory path = string.concat(root, "/config/eco.json");
        string memory network = vm.envString("NETWORK");

        address defaultProver = vm.parseJsonAddress(
            vm.readFile(path),
            string.concat(".", network, ".defaultProver")
        );

        deployed = deploy(
            abi.encodePacked(
                type(EcoFacet).creationCode,
                abi.encode(defaultProver)
            )
        );
    }
}
