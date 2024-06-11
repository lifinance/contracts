// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { CalldataVerificationFacet } from "lifi/Facets/CalldataVerificationFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("CalldataVerificationFacetFacet") {}

    function run() public returns (CalldataVerificationFacet deployed) {
        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (CalldataVerificationFacet(payable(predicted)));
        }

        deployed = CalldataVerificationFacet(
            payable(
                factory.deploy(
                    salt,
                    type(CalldataVerificationFacet).creationCode
                )
            )
        );

        vm.stopBroadcast();
    }
}
