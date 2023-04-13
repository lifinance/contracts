// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { PackedEncoderDecoderFacet } from "lifi/Facets/PackedEncoderDecoderFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("PackedEncoderDecoderFacet") {}

    function run() public returns (PackedEncoderDecoderFacet deployed) {
        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return PackedEncoderDecoderFacet(predicted);
        }

        deployed = PackedEncoderDecoderFacet(
            factory.deploy(salt, type(PackedEncoderDecoderFacet).creationCode)
        );

        vm.stopBroadcast();
    }
}
