// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { WithdrawFacet } from "lifi/Facets/WithdrawFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("WithdrawFacet") {}

    function run() public returns (WithdrawFacet deployed) {
        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return WithdrawFacet(predicted);
        }

        deployed = WithdrawFacet(
            factory.deploy(salt, type(WithdrawFacet).creationCode)
        );

        vm.stopBroadcast();
    }
}
