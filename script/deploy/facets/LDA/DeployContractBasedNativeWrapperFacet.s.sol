// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ContractBasedNativeWrapperFacet } from "lifi/Periphery/LDA/Facets/ContractBasedNativeWrapperFacet.sol";
import { DeployScriptBase } from "../utils/DeployScriptBase.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("ContractBasedNativeWrapperFacet") {}

    function run() public returns (ContractBasedNativeWrapperFacet deployed) {
        deployed = ContractBasedNativeWrapperFacet(
            deploy(type(ContractBasedNativeWrapperFacet).creationCode)
        );
    }
}
